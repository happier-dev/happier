import type * as React from 'react';
import { loadWorkspaceRouteModule } from './workspaceRouteContext';
import { workspaceRouteFiles } from './workspaceRoutes';

// Use the exact context supplied to ExpoRoot, including its sync/async mode.
// A second import() for these routes creates a second full Metro graph even
// when Expo has already included the route in the initial application graph.
async function loadRouteBody(contextKey: string): Promise<{ default: React.ComponentType }> {
    const module: unknown = await loadWorkspaceRouteModule(contextKey);
    if (module === null || typeof module !== 'object' || !('WorkspaceRouteBody' in module)) {
        throw new Error('Workspace route has no body: ' + contextKey);
    }
    const body = module.WorkspaceRouteBody;
    if (typeof body !== 'function' && (body === null || typeof body !== 'object')) {
        throw new Error('Workspace route has an invalid body: ' + contextKey);
    }
    // Metro's context is an untyped SDK boundary. The registered first-party
    // modules export React components (including memo/forwardRef components).
    return { default: body as React.ComponentType };
}

export const workspaceRouteBodies: Readonly<Record<string, () => Promise<{ default: React.ComponentType }>>> =
    Object.fromEntries(Object.entries(workspaceRouteFiles).map(([key, contextKey]) => [
        key, () => loadRouteBody(contextKey),
    ]));

export async function loadWorkspaceRouteLayout(contextKey: string): Promise<{ default: React.ComponentType }> {
    const module: unknown = await loadWorkspaceRouteModule(contextKey);
    if (module === null || typeof module !== 'object' || !('default' in module)
        || (typeof module.default !== 'function' && (module.default === null || typeof module.default !== 'object'))) {
        throw new Error('Workspace route has no layout: ' + contextKey);
    }
    // Expo's untyped module context exports React function/memo/forwardRef components.
    return { default: module.default as React.ComponentType };
}
