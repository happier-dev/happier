import { ScmDiffCache } from './scmDiffCache';

// NOTE: Limits are configured by a settings-wired hook in the SCM UI surfaces.
// This instance provides the shared storage so Review/file details can reuse cached diffs.
export const scmDiffCache = new ScmDiffCache({
    maxEntries: 30,
    maxTotalBytes: 20 * 1024 * 1024,
    now: () => Date.now(),
});
