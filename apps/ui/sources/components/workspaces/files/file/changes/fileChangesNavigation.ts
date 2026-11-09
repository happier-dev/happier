const liveFilesByChangedPaths = new WeakMap<readonly string[], Readonly<{
    paths: ReadonlySet<string>;
    files: readonly Readonly<{ path: string; unifiedDiff: string; pending: true }>[];
}>>();

/**
 * The live comparison as the File page knows it: every changed file by path only (`pending`), so the
 * review cursor can name and open the next one (rv R2, rvp P2) without the page loading every diff. The
 * open file's own diff is read by the review controller from the page, not from this list, so the list
 * stays one value per changed-path list while the person opens one file after another.
 */
export function buildFileChangesLiveFiles(changedPaths: readonly string[], filePath: string, unifiedDiff: string) {
    let base = liveFilesByChangedPaths.get(changedPaths);
    if (!base) {
        base = { paths: new Set(changedPaths), files: changedPaths.map(path => ({ path, unifiedDiff: '', pending: true as const })) };
        liveFilesByChangedPaths.set(changedPaths, base);
    }
    return base.paths.has(filePath) ? base.files : [...base.files, { path: filePath, unifiedDiff }];
}
