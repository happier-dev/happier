export type {
    ReleaseNotesAssetIndex,
    ReleaseNotesAssetIndexEntry,
    ReleaseNotesManifest,
    ReleaseNotesMediaSource,
    ReleaseNotesRelease,
    ResolvedReleaseNotesMedia,
    StoryDeckCard,
    StoryDeckImageCard,
    StoryDeckListCard,
    StoryDeckVideoCard,
    StoryDeckIconId,
    TranslationKey,
} from './types';

export {
    parseReleaseNotesAssetIndex,
    parseReleaseNotesManifest,
    ReleaseNotesAssetIndexSchema,
    ReleaseNotesManifestSchema,
    ReleaseNotesReleaseSchema,
    StoryDeckCardSchema,
} from './schema';

export {
    getActiveManifest,
    getCurrentReleaseEntry,
    getCurrentReleaseId,
    findReleaseForId,
    commitRemoteManifest,
    resetManifestRuntimeCacheForTests,
} from './manifestRuntime';

export {
    revalidateRemoteManifest,
    resetRemoteManifestForTests,
    type ReleaseNotesRevalidationResult,
} from './remoteManifest';

export {
    commitRemoteAssetIndex,
    getAssetIndex,
    setAssetIndex,
    lookupAsset,
    resetAssetIndexForTests,
} from './assetIndex';

export { resolveAssetUrl, type ResolvedAssetUrl } from './assetUrlResolver';

export {
    clearLastSeenReleaseId,
    clearCachedAssetIndex,
    emitReleaseNotesRuntimeChanged,
    getCachedAssetIndexFetchedAt,
    getCachedAssetIndexRaw,
    getCachedManifestFetchedAt,
    getCachedManifestRaw,
    getLastSeenReleaseId,
    getMigrationSeededReleaseId,
    getReleaseNotesRuntimeVersion,
    hasUnreadRelease,
    setCachedAssetIndexRaw,
    setCachedManifestRaw,
    setLastSeenReleaseId,
    setMigrationSeededReleaseId,
    subscribeLastSeenReleaseId,
    subscribeReleaseNotesRuntime,
} from './storage';

export { runReleaseNotesMigrationSeeding } from './migration';

export {
    resolveReleaseNotesLaunchOutcome,
    type ReleaseNotesLaunchOutcome,
} from './launchPolicy';

export {
    useReleaseNotesState,
    type UseReleaseNotesStateResult,
} from './useReleaseNotesState';

export {
    useReleaseNotesUnread,
    type UseReleaseNotesUnreadResult,
} from './useReleaseNotesUnread';

export {
    useReleaseNotesLauncher,
    type UseReleaseNotesLauncherResult,
} from './useReleaseNotesLauncher';

export { ReleaseNotesAutoShowMount } from './ReleaseNotesAutoShowMount';
