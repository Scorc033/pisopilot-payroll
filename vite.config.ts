import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "0.0.0.0" },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@firebase/firestore/")) return "firebase-firestore";
          if (id.includes("/node_modules/@firebase/auth/")) return "firebase-auth";
          if (id.includes("/node_modules/@firebase/")) return "firebase-core";
        },
      },
    },
  },
});
