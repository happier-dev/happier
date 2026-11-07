import { definePlugin, type BackupDestinationContributionV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

import { publicAuthoringDefinition } from './definition.js';

export const { manifest, activate, collectionMigrations } = definePlugin(publicAuthoringDefinition);
export { exerciseReviewWidgetArea } from './widgetAreas.js';
export * as usageQueryAuthoring from './usageQuery.js';
export * as usageCoachAuthoring from './usageCoach.js';
export * as sessionSectionAuthoring from './sessionSections.js';
export * as healthNoticeAuthoring from './healthNotice.js';
export { createExternalHealthKind, readEndpointMetadata } from './healthChecks.js';
export * as accountActionAuthoring from './accountActions.js';
export { botTemplateAuthoring } from './botTemplates.js';
export { sharedSecretSaveAuthoring, saveGeneratedProviderSecret, sendSavedSecretToProvider } from './sharedSecrets.js';
export { machinePageAuthoring } from './daemon.js';

/** Unreleased inert app data; registry reads never invoke plugin code. */
export const appRegistrySourceAuthoring = definePlugin({
    id: 'com.example.app-catalog', version: '0.1.0', displayName: 'App catalog author reference',
    registrySources: {
        packaged: { title: 'Packaged apps', format: 'happier-catalog', kinds: ['app'],
            packageContent: { path: 'resources/registry/apps.json' } },
        remote: { title: 'Remote apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://catalog.example/apps.json' },
    },
});

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

const destinationPluginId = 'examples.backup-destination';
const destinationInput = defineProtocolObject({
    endpoint: defineProtocolString(),
    bucket: defineProtocolString(),
    prefix: defineProtocolString(),
}, { policy: 'closed' });
const destinationDescriptor = {
    title: 'Object storage',
    configSchema: destinationInput.jsonSchema,
    credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' }],
    resticTransport: 's3',
    locality: 'unknown',
    actions: {
        test: { pluginId: destinationPluginId, localId: 'destination/test' },
        open: { pluginId: destinationPluginId, localId: 'destination/open' },
    },
} as const satisfies Omit<BackupDestinationContributionV1, 'id'>;
// This result belongs only to this conformance example, not the backup protocol.
const nativeTransportUnavailable = defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    reason: defineProtocolLiteral('example_has_no_native_transport'),
}, { policy: 'closed' });

/** Declares and binds storage access without inventing a runner or credential service. */
export const backupDestinationAuthoring = definePlugin({
    id: destinationPluginId,
    version: '0.1.0',
    displayName: 'Backup destination authoring reference',
    backupDestinations: { repository: destinationDescriptor },
    actions: {
        'destination/test': {
            title: 'Test destination (conformance reference)',
            execution: { target: 'daemon' },
            surfaces: ['plugin'],
            dangerLevel: 'writesRemote',
            inputSchema: destinationInput,
            resultSchema: nativeTransportUnavailable,
            // A real test owns its bounded probe and cleanup within one invocation.
            run: () => ({ kind: 'unavailable', reason: 'example_has_no_native_transport' } as const),
        },
        'destination/open': {
            title: 'Open destination (conformance reference)',
            execution: { target: 'daemon' },
            surfaces: ['plugin'],
            dangerLevel: 'safe',
            inputSchema: destinationInput,
            resultSchema: nativeTransportUnavailable,
            // No credentials, locator or argv is returned without the native owner.
            run: () => ({ kind: 'unavailable', reason: 'example_has_no_native_transport' } as const),
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
