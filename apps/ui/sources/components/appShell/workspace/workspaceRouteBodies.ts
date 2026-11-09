import type * as React from 'react';
import { loadWorkspaceRouteModule } from './workspaceRouteContext';
import { workspaceMachinePageRouteKey, workspaceRouteFiles } from './workspaceRoutes';

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

const workflowEditorBody = () => loadRouteBody(workspaceRouteFiles['workflows/[id]']!);
// Every Project page route exports the same Project body. One loader (one lazy type) keeps the
// Project host, its chrome and panes mounted when only its page changes (Overview -> Code, plugin pages).
const projectPageBody = () => loadRouteBody(workspaceRouteFiles['projects/[workspaceRefId]']!);
// One loader/type per Machine leaf in either door. The shell supplies the door context.
const machinePageBodies = new Map<string, () => Promise<{ default: React.ComponentType }>>();
export const workspaceRouteBodies: Readonly<Record<string, () => Promise<{ default: React.ComponentType }>>> =
    Object.fromEntries(Object.entries(workspaceRouteFiles).map(([key, contextKey]) => {
        if (key === 'projects/[workspaceRefId]' || key.startsWith('projects/[workspaceRefId]/')) return [key, projectPageBody];
        const machineKey = workspaceMachinePageRouteKey(key);
        if (machineKey) {
            let load = machinePageBodies.get(machineKey);
            if (!load) {
                load = () => loadRouteBody(workspaceRouteFiles[`settings/${machineKey}`]!);
                machinePageBodies.set(machineKey, load);
            }
            return [key, load];
        }
        return [key, key === 'workflows/new' || key === 'workflows/[id]' ? workflowEditorBody : () => loadRouteBody(contextKey)];
    }));

export async function loadWorkspaceRouteLayout(contextKey: string): Promise<{ default: React.ComponentType }> {
    const module: unknown = await loadWorkspaceRouteModule(contextKey);
    if (module === null || typeof module !== 'object' || !('default' in module)
        || (typeof module.default !== 'function' && (module.default === null || typeof module.default !== 'object'))) {
        throw new Error('Workspace route has no layout: ' + contextKey);
    }
    // Expo's untyped module context exports React function/memo/forwardRef components.
    return { default: module.default as React.ComponentType };
}
