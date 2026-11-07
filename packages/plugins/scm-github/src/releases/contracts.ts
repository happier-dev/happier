/** Pure Action identities shared by daemon declarations and the sole UI artifact. */
export const GITHUB_RELEASE_ACTION_IDS_V1 = Object.freeze({
    listReleases: 'github/releases/list', readLatestRelease: 'github/releases/latest-read',
    readRelease: 'github/releases/release-read', listAssets: 'github/releases/assets-list',
    downloadAsset: 'github/releases/asset-download', generateReleaseNotes: 'github/releases/notes-generate',
    createReleaseDraft: 'github/releases/draft-create', editReleaseDraft: 'github/releases/draft-edit',
    publishReleaseDraft: 'github/releases/draft-publish', readNotesContext: 'github/releases/notes-context-read',
} as const);
export const GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 = 'ui/release-view-v1';
