export function appendTauriQaHmrOptOut(pathname) {
    const rawPath = String(pathname ?? '').trim();
    if (!rawPath.startsWith('/')) {
        throw new Error(`Expected an absolute pathname starting with "/": ${rawPath}`);
    }

    const [pathOnly, hashFragment = ''] = rawPath.split('#', 2);
    const [basePath, queryString = ''] = pathOnly.split('?', 2);
    const params = new URLSearchParams(queryString);
    params.set('happier_hmr', '0');
    const nextQuery = params.toString();
    const nextPath = nextQuery ? `${basePath}?${nextQuery}` : basePath;
    return hashFragment ? `${nextPath}#${hashFragment}` : nextPath;
}
