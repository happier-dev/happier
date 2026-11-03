import { definePlugin } from '@happier-dev/plugin-sdk';

import { publicAuthoringDefinition } from './definition.js';

export const { manifest, activate, collectionMigrations } = definePlugin(publicAuthoringDefinition);
export { exerciseReviewWidgetArea } from './widgetAreas.js';
export * as usageQueryAuthoring from './usageQuery.js';
export * as usageCoachAuthoring from './usageCoach.js';

/** Unreleased cold setup declarations; native support belongs to the host. */
export const machineSetupAuthoring = definePlugin({
    id: 'com.example.machine-setup',
    version: '0.1.0',
    displayName: 'Machine setup author reference',
    machineRecipes: {
        fonts: {
            revision: '1',
            title: 'Fonts',
            icon: 'file',
            software: true,
            inputSchema: { type: 'object', properties: { identity: {
                type: 'object', properties: { name: { type: 'string', enum: ['fonts-dejavu-core', 'fonts-noto-core'] } },
                required: ['name'], additionalProperties: false } }, required: ['identity'], additionalProperties: false },
            inputHints: { fields: [{ path: 'identity.name', title: { key: 'fonts.package', fallback: 'Font package' },
                widget: 'text', required: true }] },
            steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ kind: 'input', path: 'identity' }] }],
        },
    },
    machineSetupPresets: {
        'browser-bot': {
            revision: '1',
            title: 'Browser bot tools',
            description: "Fonts for this bot's own browser tools",
            setup: { items: [{ kind: 'softwareRecipe', selection: {
                ref: { pluginId: 'com.example.machine-setup', recipeId: 'fonts', revision: '1' }, inputs: { identity: { name: 'fonts-dejavu-core' } },
            } }] },
        },
        'ordered-scripts': {
            revision: '1',
            title: 'Ordered script reference',
            description: 'Run browser setup checks in declaration order',
            setup: { scripts: [
                { body: '\r\necho Browser tools ready\r\n', affects: 'none' },
                { body: 'echo Browser setup checked\n', affects: 'none',
                    check: { executable: 'test', args: ['-f', '/tmp/browser-setup-ready'], unsatisfiedExitCodes: [1] } },
            ] },
        },
    },
});

// The author build emits this entry as `dist/daemon.js`; retain the locator
// consumed by the separately emitted definition module as a named ESM export.
export { reviewAgentRunnerFactory } from './daemon.js';

export {
    createReviewAgentRuntime,
    observeSessionSpawned,
    reviewReferenceProvider,
    reviewSessionStatusResource,
    resolveAgentContextCompanionComposition,
    runExternalSessionDigest,
    runReviewSummary,
} from './definition.js';
