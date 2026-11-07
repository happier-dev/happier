import type { GithubReleaseInvocationContextV1 } from './operations.js';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
    ForgeReleaseActionInputSchemasV1, ForgeReleaseActionResultSchemasV1,
    ForgeReleaseMountedIntentInputV1Schema, ForgeReleaseMountedIntentResultV1Schema,
    type ForgeReleaseOperationIdV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { GITHUB_RELEASE_ACTION_IDS_V1, GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } from './contracts.js';
export { GITHUB_RELEASE_ACTION_IDS_V1, GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } from './contracts.js';
function operation<K extends ForgeReleaseOperationIdV1>(id: K, title: string) {
    return {
        title, surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const,
        placementBindings: [], dangerLevel: 'safe' as const,
        inputSchema: ForgeReleaseActionInputSchemasV1[id].jsonSchema,
        resultSchema: ForgeReleaseActionResultSchemasV1[id].jsonSchema,
        hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
        run: async (input: unknown, context: GithubReleaseInvocationContextV1<K>) =>
            projectNativeJsonValueForTransport(await (await import('./operations.js')).executeGithubReleaseOperationV1(id, input, context)),
    };
}
const saveConfirmation = { title: 'Save this GitHub draft?', body: 'Save these release notes as an unpublished draft on GitHub.', confirmLabel: 'Save draft' };
export const GITHUB_RELEASE_ACTIONS_V1 = {
    [GITHUB_RELEASE_ACTION_IDS_V1.listReleases]: operation('listReleases', 'List repository releases'),
    [GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease]: operation('readLatestRelease', 'Read the provider latest release'),
    [GITHUB_RELEASE_ACTION_IDS_V1.readRelease]: operation('readRelease', 'Read an exact release'),
    [GITHUB_RELEASE_ACTION_IDS_V1.listAssets]: operation('listAssets', 'List release assets'),
    [GITHUB_RELEASE_ACTION_IDS_V1.generateReleaseNotes]: operation('generateReleaseNotes', 'Generate a release-note proposal'),
    [GITHUB_RELEASE_ACTION_IDS_V1.readNotesContext]: operation('readNotesContext', 'Read selected release-note evidence'),
    [GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft]: {
        ...operation('createReleaseDraft', 'Save a new release draft'), dangerLevel: 'writesRemote' as const,
        confirmationWhen: { presentUserUi: false } as const, confirmation: saveConfirmation,
    },
    [GITHUB_RELEASE_ACTION_IDS_V1.editReleaseDraft]: {
        ...operation('editReleaseDraft', 'Save changes to this release draft'), dangerLevel: 'writesRemote' as const,
        confirmationWhen: { presentUserUi: false } as const, confirmation: saveConfirmation,
    },
    [GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft]: {
        ...operation('publishReleaseDraft', 'Publish this saved release draft'), dangerLevel: 'destructive' as const,
        irreversible: true as const,
        description: 'Publish the exact saved draft after a fresh review of its tag, target, notes, prerelease/latest choice and existing assets. '
            + 'Publication is visible to repository readers and may notify subscribers or trigger repository automation. '
            + 'Provider-reported immutable publication protects tag and assets. An unknown immutable policy is not a promise that assets stay editable. '
            + 'This Action never saves unsaved fields, edits an already published release, or replays an uncertain result.',
        confirmation: { title: 'Publish this release?', body: 'Publish this exact saved draft for repository readers. '
            + 'Review the selected tag, target, notes, existing assets and latest choice. Publication has no local Undo; '
            + 'immutable release policy can lock its tag and assets. Unknown policy remains unknown.', confirmLabel: 'Publish release',
            inputFields: [
                { path: 'reviewed.repository.deployment', title: 'GitHub deployment' },
                { path: 'reviewed.repository.repository', title: 'Repository' },
                { path: 'releaseId', title: 'Release ID' },
                { path: 'reviewed.tagName', title: 'Tag' },
                { path: 'reviewed.targetCommitish', title: 'Target' },
                { path: 'reviewed.name', title: 'Title' },
                { path: 'reviewed.body', title: 'Notes' },
                { path: 'reviewed.prerelease', title: 'Prerelease' },
                { path: 'makeLatest', title: 'Latest choice' },
                { path: 'reviewed.repositoryVisibility', title: 'Repository visibility' },
                { path: 'reviewed.immutable', title: 'Immutable policy' },
                { path: 'reviewed.assets.rows.[].assetId', title: 'Asset IDs' },
                { path: 'reviewed.assets.rows.[].name', title: 'Asset names' },
                { path: 'reviewed.assets.rows.[].label', title: 'Asset labels' },
                { path: 'reviewed.assets.rows.[].size', title: 'Asset sizes in bytes' },
                { path: 'reviewed.assets.rows.[].contentType', title: 'Asset content types' },
                { path: 'reviewed.assets.rows.[].state', title: 'Asset states' },
                { path: 'reviewed.assets.rows.[].digest', title: 'Asset digests' },
            ],
        },
    },
    [GITHUB_RELEASE_ACTION_IDS_V1.downloadAsset]: {
        ...operation('downloadAsset', 'Download this release asset'), dangerLevel: 'writesLocal' as const,
        operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } as const,
        hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE, 'github-downloads'],
        confirmationWhen: { presentUserUi: false } as const,
        confirmation: { title: 'Download this release asset?', body: 'Write the selected asset to the receiving device’s admitted destination, preserving its overwrite choice.', confirmLabel: 'Download' },
    },
    [GITHUB_RELEASE_MOUNTED_ACTION_ID_V1]: {
        title: 'Control the mounted Releases editor', description: 'Read current UI context for the mountId and operandless commands. '
            + 'Typed operations change only the addressed mounted editor. Save and Publish are separate provider Actions.',
        dangerLevel: 'safe' as const, surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli'] as const, placementBindings: [],
        execution: { target: 'client', client: { artifactId: 'github-forge-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] } as const,
        inputSchema: ForgeReleaseMountedIntentInputV1Schema.jsonSchema, resultSchema: ForgeReleaseMountedIntentResultV1Schema.jsonSchema,
    },
};
