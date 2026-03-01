import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

export type SessionPaneUrlDetailsTarget =
    | Readonly<{ kind: 'file'; path: string }>
    | Readonly<{ kind: 'commit'; sha: string }>;

export type SessionPaneUrlState = Readonly<{
    rightTabId?: 'git' | 'files';
    details?: SessionPaneUrlDetailsTarget;
}>;

type PaneScopeStateLike = Readonly<{
    right: Readonly<{ isOpen: boolean; activeTabId: string | null }>;
    details: Readonly<{ isOpen: boolean; tabs: ReadonlyArray<Readonly<{ key: string; kind: string; resource: unknown }>>; activeTabKey: string | null }>;
}>;

function readSingleStringParam(params: Readonly<Record<string, unknown>>, key: string): string | null {
    const raw = params[key];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        const first = raw[0];
        return typeof first === 'string' ? first : null;
    }
    return null;
}

export function parseSessionPaneUrlState(params: Readonly<Record<string, unknown>>): SessionPaneUrlState | null {
    const rightRaw = readSingleStringParam(params, 'right')?.trim() ?? '';
    const rightTabId = rightRaw === 'git' || rightRaw === 'files' ? rightRaw : null;

    const detailsRaw = readSingleStringParam(params, 'details')?.trim() ?? '';
    const pathRaw = readSingleStringParam(params, 'path')?.trim() ?? '';
    const shaRaw = readSingleStringParam(params, 'sha')?.trim() ?? '';

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (detailsRaw === 'file' && pathRaw && isSafeWorkspaceRelativePath(pathRaw)) {
        details = { kind: 'file', path: pathRaw.trim() };
    }
    if (detailsRaw === 'commit' && shaRaw) {
        details = { kind: 'commit', sha: shaRaw };
    }

    if (!rightTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(details ? { details } : null),
    };
}

export function serializeSessionPaneUrlState(state: SessionPaneUrlState): Record<string, string> {
    const out: Record<string, string> = {};
    if (state.rightTabId) {
        out.right = state.rightTabId;
    }
    if (state.details?.kind === 'file') {
        out.details = 'file';
        out.path = state.details.path;
    }
    if (state.details?.kind === 'commit') {
        out.details = 'commit';
        out.sha = state.details.sha;
    }
    return out;
}

export function deriveSessionPaneUrlStateFromScopeState(scopeState: PaneScopeStateLike | null): SessionPaneUrlState | null {
    if (!scopeState) return null;
    const rightTabId =
        scopeState.right.isOpen && (scopeState.right.activeTabId === 'git' || scopeState.right.activeTabId === 'files')
            ? scopeState.right.activeTabId
            : null;

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (scopeState.details.isOpen && scopeState.details.activeTabKey) {
        const tab = scopeState.details.tabs.find((t) => t.key === scopeState.details.activeTabKey) ?? null;
        if (tab?.kind === 'file') {
            const path = (tab.resource as any)?.path;
            if (typeof path === 'string' && path.trim()) {
                const trimmedPath = path.trim();
                if (isSafeWorkspaceRelativePath(trimmedPath)) {
                    details = { kind: 'file', path: trimmedPath };
                }
            }
        } else if (tab?.kind === 'commit') {
            const sha = (tab.resource as any)?.sha;
            if (typeof sha === 'string' && sha.trim()) {
                const safeSha = sha.trim().split(/\s+/)[0] ?? '';
                if (safeSha) {
                    details = { kind: 'commit', sha: safeSha };
                }
            }
        }
    }

    if (!rightTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(details ? { details } : null),
    };
}

export function applySessionPaneUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        setRightTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
    }>,
    state: SessionPaneUrlState
): void {
    if (state.rightTabId) {
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
    }

    if (state.details?.kind === 'file') {
        const fullPath = state.details.path.trim();
        if (!isSafeWorkspaceRelativePath(fullPath)) return;
        const fileName = fullPath.split('/').pop() ?? fullPath;
        pane.openDetailsTab({
            key: `file:${fullPath}`,
            kind: 'file',
            title: fileName,
            resource: { kind: 'file', path: fullPath },
        });
        return;
    }

    if (state.details?.kind === 'commit') {
        const safeSha = state.details.sha.trim().split(/\s+/)[0] ?? '';
        if (!safeSha) return;
        pane.openDetailsTab({
            key: `commit:${safeSha}`,
            kind: 'commit',
            title: safeSha.slice(0, 7),
            resource: { kind: 'commit', sha: safeSha },
        });
    }
}

export function reconcileSessionPaneScopeFromUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        closeRight: () => void;
        setRightTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
        closeDetails: () => void;
    }>,
    state: SessionPaneUrlState | null
): void {
    if (state?.rightTabId) {
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
    } else {
        pane.closeRight();
    }

    if (state?.details) {
        applySessionPaneUrlState(pane, { details: state.details });
    } else {
        pane.closeDetails();
    }
}
