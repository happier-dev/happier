import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import uiConfig from '../ui/vitest.config';
import { serverWorkspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';
import { workspacePackageSourcesPlugin as cliWorkspacePackageSourcesPlugin } from '../cli/scripts/vitestWorkspacePackageResolution';

const requireUi = createRequire(new URL('../ui/package.json', import.meta.url));

// A composed UI → server journey needs the UI's native/Expo system boundaries,
// while each first-party import retains its own package's @/ source authority.
export default defineConfig({
    ...uiConfig,
    plugins: [serverWorkspacePackageSourcesPlugin, cliWorkspacePackageSourcesPlugin, ...uiConfig.plugins, tsconfigPaths({ projects: [
        fileURLToPath(new URL('./tsconfig.vitest.json', import.meta.url)),
        fileURLToPath(new URL('../ui/tsconfig.json', import.meta.url)),
        fileURLToPath(new URL('../cli/tsconfig.json', import.meta.url)),
    ] })],
    resolve: { ...uiConfig.resolve, alias: [
        // The native renderer belongs to UI. With Server as the runner root,
        // bare deduplication otherwise selects Server's different React copy.
        ...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-test-renderer'].map(name => ({
            find: new RegExp(`^${name.replaceAll('/', '\\/')}$`), replacement: requireUi.resolve(name),
        })),
        ...uiConfig.resolve.alias.filter(alias => alias.find !== '@'),
    ] },
    test: {
        ...uiConfig.test,
        fileParallelism: false,
        include: [
            'sources/app/session/organization/sessionOrganizationReseal.sqlite.composed.integration.spec.ts',
            'sources/app/artifacts/artifactInventoryPublications.composed.integration.spec.ts',
            'sources/app/api/routes/connect/qualifiedConnectedAccounts/usagePageProjection.composed.integration.spec.ts',
            'sources/app/session/sessionSharedActionConfirmation.sqlite.composed.integration.spec.ts',
            'sources/app/automations/automationCrudService.composed.integration.spec.ts',
            'sources/app/workflows/workflowRunAttention.composed.integration.spec.ts',
            'sources/app/discussions/discussionExternalComposer.sqlite.composed.integration.spec.ts',
        ],
        exclude: [],
    },
});
