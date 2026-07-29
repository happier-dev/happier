export function isSessionSyncHttpRoute(routePath: string): boolean {
    return routePath === '/v2/changes'
        || routePath === '/v2/cursor'
        || routePath === '/v1/sessions'
        || routePath.startsWith('/v1/sessions/')
        || routePath === '/v2/sessions'
        || routePath.startsWith('/v2/sessions/');
}
