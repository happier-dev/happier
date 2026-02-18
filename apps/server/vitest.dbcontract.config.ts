import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveVitestFeatureTestExcludeGlobs } from "../../scripts/testing/featureTestGating";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["**/*.dbcontract.spec.ts"],
        exclude: [...resolveVitestFeatureTestExcludeGlobs()],
        isolate: true,
        testTimeout: 60_000,
        hookTimeout: 60_000,
        env: {
            HAPPIER_FEATURE_POLICY_ENV: "",
        },
    },
    // Restrict tsconfig resolution to server only.
    // Otherwise vite-tsconfig-paths may scan the repo and attempt to parse Expo tsconfigs.
    plugins: [tsconfigPaths({ projects: [resolve(__dirname, "./tsconfig.json")] })],
});
