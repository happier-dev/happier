type WorkspaceRouteContext = ((key: string) => unknown) & { keys?: () => string[] };

let routeContext: WorkspaceRouteContext | null = null;

// The root layout publishes ExpoRoot's existing context before workspace
// children mount. Keep only its reference here, not another context or cache.
export function registerWorkspaceRouteContext(context: WorkspaceRouteContext): void {
    routeContext = context;
}

export function loadWorkspaceRouteModule(key: string): unknown {
    if (!routeContext) throw new Error('Workspace route context has not been registered by the root layout');
    return routeContext(key);
}

/** Settings inherits the same ancestor layouts Expo would select for this module. */
export function workspaceSettingsLayoutKeys(contextKey: string): readonly string[] {
    if (!contextKey.startsWith('./(app)/settings/')) return [];
    if (!routeContext?.keys) throw new Error('Workspace route context must expose its module keys');
    const available = new Set(routeContext.keys());
    const segments = contextKey.split('/');
    const layouts: string[] = [];
    for (let length = 3; length < segments.length; length++) {
        const key = `${segments.slice(0, length).join('/')}/_layout.tsx`;
        if (available.has(key)) layouts.push(key);
    }
    return layouts;
}
