import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { serverWorkspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';
import { workspacePackageSourcesPlugin as cliWorkspacePackageSourcesPlugin } from '../cli/scripts/vitestWorkspacePackageResolution';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const homeIrohRealIntegrationTest = 'sources/app/iroh/homeIrohEndpoint.real.integration.test.ts';

export default defineConfig({
  server: { fs: { allow: [resolve(__dirname, '../..')] } },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [resolve(__dirname, '../../scripts/testing/vitestHomeSetup.mjs'), './sources/configureZodLocale.ts'],
    sequence: { setupFiles: 'list' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    include: [
      'sources/**/*.integration.spec.ts',
      'sources/**/*.integration.test.ts',
      'sources/**/*.real.integration.test.ts',
      'scripts/**/*.integration.spec.ts',
      'scripts/**/*.integration.test.ts',
      'scripts/**/*.real.integration.test.ts',
    ],
    exclude: [
      ...resolveVitestFeatureTestExcludeGlobs(),
      // The public integration lane runs this with the UI's native/Expo boundary harness.
      'sources/app/session/organization/sessionOrganizationReseal.sqlite.composed.integration.spec.ts',
      'sources/app/artifacts/artifactInventoryPublications.composed.integration.spec.ts',
      'sources/app/api/routes/connect/qualifiedConnectedAccounts/usagePageProjection.composed.integration.spec.ts',
      'sources/app/session/sessionSharedActionConfirmation.sqlite.composed.integration.spec.ts',
      'sources/app/automations/automationCrudService.composed.integration.spec.ts',
      'sources/app/workflows/workflowRunAttention.composed.integration.spec.ts',
      'sources/app/discussions/discussionExternalComposer.sqlite.composed.integration.spec.ts',
      ...(process.env.HAPPIER_IROH_REQUIRE_NODE_ADDON === '1' ? [] : [homeIrohRealIntegrationTest]),
    ],
    isolate: true,
    env: {
      ...createTestHomeEnvironment().env,
      HAPPIER_FEATURE_POLICY_ENV: '',
      S3_HOST: 'localhost',
      S3_PORT: '9000',
      S3_USE_SSL: 'false',
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
      S3_BUCKET: 'test'
    }
  },
  // The Data direct-client integration test imports the UI-owned adapter through
  // its real source boundary. `vite-tsconfig-paths` selects the nearest project
  // for each importer, so server, UI, and CLI `@/` aliases remain separate owners.
  plugins: [
    serverWorkspacePackageSourcesPlugin,
    // Composed Action/approval specs consume the CLI's production wiring; use
    // its manifest-derived source closure instead of externalizing stale dist.
    cliWorkspacePackageSourcesPlugin,
    tsconfigPaths({
      projects: [
        // Test import resolution includes composed specs; production compilation
        // keeps its own expensive-fixture exclusion in the base project.
        resolve(__dirname, './tsconfig.vitest.json'),
        resolve(__dirname, '../ui/tsconfig.json'),
        resolve(__dirname, '../cli/tsconfig.vitest.json'),
      ],
    }),
  ]
});
