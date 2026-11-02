import * as React from 'react';
import { readWorkspaceFileEditorDraft } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft';
import { getOwnDetailsWorkspaceRecordEntry, type DetailsTabState, type PaneDetailsStateView } from './detailsWorkspaceTypes';
import type { AppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { normalizeWorkspaceScopeBase, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSessionFromState, type WorkspaceTargetForSessionState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

function dirtyFiles(accountId: string, tabs: readonly DetailsTabState[], tabState: Readonly<Record<string, unknown>>): Readonly<{ path: string; rootPath?: string }>[] {
    return tabs.flatMap(tab => {
        if (tab.kind !== 'file' || !readWorkspaceFileEditorDraft(getOwnDetailsWorkspaceRecordEntry(tabState, tab.key), accountId)?.isEditingFile
            || !tab.resource || typeof tab.resource !== 'object') return [];
        const { path, rootPath } = tab.resource as Readonly<{ path?: unknown; rootPath?: unknown }>;
        return typeof path === 'string' && path ? [{ path, ...(typeof rootPath === 'string' ? { rootPath } : {}) }] : [];
    });
}

/** Persisted drafts exist only while dirty, including editors whose tab body is not mounted. */
export function unsavedWorkspaceFilePaths(scope: Readonly<{ accountId: string | null }> & (Readonly<{
    /** A caller already inside this exact pane needs no Machine availability to protect its drafts. */
    details: (Pick<PaneDetailsStateView, 'tabs' | 'tabState'> & Partial<Pick<PaneDetailsStateView, 'groups'>>) | null | undefined;
    rootPath?: string | null;
}> | Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    paneScopes: AppPaneState['scopes'] | null | undefined;
    workspaceRefs: readonly WorkspaceRefV1[];
    sessionState: WorkspaceTargetForSessionState;
}>)): readonly string[] {
    if (!scope.accountId) return [];
    if ('details' in scope) {
        if (!scope.details) return [];
        const tabs = [...scope.details.tabs, ...(scope.details.groups?.flatMap(group => group.tabs) ?? [])];
        const files = dirtyFiles(scope.accountId, tabs, scope.details.tabState);
        return [...new Set(files.flatMap(({ path, rootPath }) => {
            if (!scope.rootPath) return [path];
            const absolute = resolveMachineAbsolutePath({ rootPath: rootPath ?? scope.rootPath, requestPath: path, pathKind: 'workspace_entry' });
            const relative = resolvePathRelativeToRoot({ path: absolute, root: scope.rootPath, preservePathSpelling: true });
            return relative && relative !== '.' ? [relative] : [];
        }))];
    }
    const target = scope.workspaceScope ? normalizeWorkspaceScopeBase(scope.workspaceScope) : null;
    if (!target || !scope.paneScopes) return [];
    const paths = new Set<string>();
    for (const [scopeId, pane] of Object.entries(scope.paneScopes)) {
        const files = dirtyFiles(scope.accountId, Object.values(pane.details.tabsByKey), pane.details.tabState);
        if (!files.length) continue;
        // Destination instances share file identity, not tab state. Resolve each
        // actual pane through the existing Project/Session target owners.
        const project = parseProjectPaneScopeId(scopeId);
        const ref = project ? resolveWorkspaceRefById(scope.workspaceRefs, project.workspaceRefId, project.serverId) : null;
        const session = project ? null : parseSessionPaneScopeId(scopeId);
        const source = ref?.kind === 'resolved' ? normalizeWorkspaceScopeBase(ref.ref)
            : session?.address ? resolveWorkspaceTargetForSessionFromState(scope.sessionState, session.address) : null;
        if (!source || source.serverId !== target.serverId || source.machineId !== target.machineId) continue;
        for (const { path, rootPath } of files) {
            const absolute = resolveMachineAbsolutePath({ rootPath: rootPath ?? source.rootPath, requestPath: path, pathKind: 'workspace_entry' });
            const relative = resolvePathRelativeToRoot({ path: absolute, root: target.rootPath, preservePathSpelling: true });
            if (relative && relative !== '.') paths.add(relative);
        }
    }
    return [...paths];
}

/**
 * What a tab's content tells the strip about itself: today only that it holds unsaved edits (a
 * file being edited). The content is the only owner of that fact; the strip draws it.
 */
export type DetailsTabChromeApi = Readonly<{
    setUnsaved: (unsaved: boolean) => void;
}>;

const NOOP_CHROME: DetailsTabChromeApi = { setUnsaved: () => {} };

const DetailsTabChromeContext = React.createContext<DetailsTabChromeApi>(NOOP_CHROME);

export function DetailsTabChromeProvider(props: Readonly<{ value: DetailsTabChromeApi; children: React.ReactNode }>) {
    return <DetailsTabChromeContext.Provider value={props.value}>{props.children}</DetailsTabChromeContext.Provider>;
}

/** Outside a Details tab (a full-screen file route) the report goes nowhere. */
export function useDetailsTabChrome(): DetailsTabChromeApi {
    return React.useContext(DetailsTabChromeContext);
}

/**
 * The group's record of unsaved tabs. It changes only when a tab's fact flips, so the strip
 * re-renders on an edit's first keystroke and on save, never per keystroke.
 */
export function useDetailsTabUnsavedKeys(pinTab: (tabKey: string, options?: Readonly<{ persist?: boolean }>) => void): Readonly<{
    unsavedKeys: ReadonlySet<string>;
    chromeFor: (tabKey: string) => DetailsTabChromeApi;
}> {
    const [unsavedKeys, setUnsavedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pinTabRef = React.useRef(pinTab);
    pinTabRef.current = pinTab;
    const chromeByKeyRef = React.useRef(new Map<string, DetailsTabChromeApi>());
    const chromeFor = React.useCallback((tabKey: string): DetailsTabChromeApi => {
        const existing = chromeByKeyRef.current.get(tabKey);
        if (existing) return existing;
        let reportedUnsaved = false;
        const chrome: DetailsTabChromeApi = {
            setUnsaved: (unsaved) => {
                if (reportedUnsaved === unsaved) return;
                reportedUnsaved = unsaved;
                if (unsaved) pinTabRef.current(tabKey, { persist: false });
                setUnsavedKeys((current) => {
                    if (current.has(tabKey) === unsaved) return current;
                    const next = new Set(current);
                    if (unsaved) next.add(tabKey);
                    else next.delete(tabKey);
                    return next;
                });
            },
        };
        chromeByKeyRef.current.set(tabKey, chrome);
        return chrome;
    }, []);
    return { unsavedKeys, chromeFor };
}
