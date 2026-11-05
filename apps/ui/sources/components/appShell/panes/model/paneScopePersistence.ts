import type { z } from 'zod/mini';
import type { PaneScopeState } from './appPaneReducer';
import type { PersistedPaneScopeSchema } from './paneScopePersistenceSchema';
import { createBuiltinPaneDestination, enumerateSelectedPaneSlots, findSelectedPaneSlot } from './selectedPaneDestination';
import { closeTerminalDetailsTabs, moveTerminalWorkspaceToPane } from './terminalPaneDocking';
import { readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { arePaneStateJsonValuesEqual } from './paneStateStructuralEquality';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from '../details/workspace/migrateLegacyDetailsWorkspaceState';
import { placeDetailsInSideColumn } from './detailsPanePlacement';

type PersistedPaneScope = z.infer<typeof PersistedPaneScopeSchema>;

/** Shell membership belongs to the retained record; each presenter keeps its own layout and drafts. */
export function reconcilePersistedTerminalWorkspace(local: PaneScopeState, terminal: unknown): PaneScopeState {
    if (terminal === undefined || arePaneStateJsonValuesEqual(local.bottom.tabState.terminal, terminal)) return local;
    const retainedIds = new Set(readSessionTerminalWorkspace(terminal).tabs.flatMap(tab => tab.terminals.map(member => member.id)));
    const removedIds = new Set(readSessionTerminalWorkspace(local.bottom.tabState.terminal).tabs
        .flatMap(tab => tab.terminals.map(member => member.id)).filter(id => !retainedIds.has(id)));
    return { ...local,
        details: removedIds.size ? closeTerminalDetailsTabs(local.details, removedIds) : local.details,
        bottom: { ...local.bottom, tabState: { ...local.bottom.tabState, terminal } },
    };
}

/** A realm writes its presented content; the source layout remains the placement/membership owner. */
export function mergePaneScopePresentationState(
    local: PaneScopeState,
    stored: PaneScopeState | null,
    presentedTabKey?: string,
    selectedPaneTabKey?: string,
): PaneScopeState {
    if (!stored) return local;
    const copyTabState = (from: Pick<PaneScopeState['details'], 'tabState'>, into: Record<string, unknown>, key: string) => {
        if (Object.hasOwn(from.tabState, key)) into[key] = from.tabState[key];
        else delete into[key];
    };
    if (presentedTabKey) {
        const slot = findSelectedPaneSlot(local, presentedTabKey);
        if (slot && slot.slot !== 'detailsOverlay') {
            const selected = local[slot.slot];
            return { ...stored, [slot.slot]: { ...stored[slot.slot],
                ...(selectedPaneTabKey === presentedTabKey ? { activeTabId: selected.activeTabId, selectedDestination: selected.selectedDestination } : {}),
                tabState: selected.tabState } };
        }
        if (slot?.slot === 'detailsOverlay' && selectedPaneTabKey === presentedTabKey) {
            return { ...stored, details: { ...stored.details, overlay: local.details.overlay } };
        }
        const tabState = { ...stored.details.tabState };
        copyTabState(serializeDetailsWorkspaceState(local.details), tabState, presentedTabKey);
        return { ...stored, details: { ...stored.details, tabState } };
    }
    const placedKeys = Object.values(local.details.tabsByKey).filter(tab => tab.presentation).map(tab => tab.key);
    let merged = local;
    for (const selected of enumerateSelectedPaneSlots(local)) {
        if (!selected.presentation) continue;
        const slot = selected.slot;
        if (slot === 'detailsOverlay') {
            if (selectedPaneTabKey !== selected.tabKey && stored.details.overlay) {
                merged = { ...merged, details: { ...merged.details,
                    overlay: { ...stored.details.overlay, presentation: selected.presentation } } };
            }
            continue;
        }
        merged = { ...merged, [slot]: { ...merged[slot],
            ...(selectedPaneTabKey === selected.tabKey ? {} : {
                activeTabId: stored[slot].activeTabId, selectedDestination: stored[slot].selectedDestination,
            }), tabState: stored[slot].tabState } };
    }
    if (!placedKeys.length) return merged;
    const tabState = { ...local.details.tabState };
    for (const key of placedKeys) copyTabState(stored.details, tabState, key);
    return { ...merged, details: { ...merged.details, tabState } };
}

function normalizePersistedPaneSlot(slot: PersistedPaneScope['right'], restoreOpenPanes: boolean): PaneScopeState['right'] {
    // Preserve the predecessor's built-in selection at the persistence boundary.
    // The reducer never guesses whether a legacy string was a plugin id.
    return {
        isOpen: restoreOpenPanes && slot.isOpen,
        activeTabId: slot.activeTabId ?? null,
        selectedDestination: slot.selectedDestination
            ?? (slot.activeTabId ? createBuiltinPaneDestination(slot.activeTabId) : null),
        ...(slot.presentation ? { presentation: slot.presentation } : {}),
        tabState: slot.tabState,
    };
}

export function normalizePersistedPaneScopes(
    value: Readonly<Record<string, PersistedPaneScope>>,
    restoreOpenPanes: boolean,
): Readonly<Record<string, PaneScopeState>> {
    return Object.fromEntries(Object.entries(value).map(([scopeId, scope]) => {
        const details = migrateLegacyDetailsWorkspaceState(scope.details);
        const normalized: PaneScopeState = {
            mainHidden: restoreOpenPanes && scope.mainHidden === true,
            ...(scope.mainTabId === undefined ? {} : { mainTabId: scope.mainTabId }),
            right: normalizePersistedPaneSlot(scope.right, restoreOpenPanes),
            details: restoreOpenPanes || !details.isOpen ? details : { ...details, isOpen: false },
            bottom: normalizePersistedPaneSlot(scope.bottom, restoreOpenPanes),
        };
        // Desktop terminals default to the bottom dock, including restored duplicate views.
        const bottomDocked = normalized.bottom.isOpen
            ? moveTerminalWorkspaceToPane(normalized, normalized.bottom.selectedDestination, 'bottom')
            : normalized;
        return [scopeId, placeDetailsInSideColumn(bottomDocked.right.isOpen
            ? moveTerminalWorkspaceToPane(bottomDocked, bottomDocked.right.selectedDestination, 'right')
            : bottomDocked)];
    }));
}

export function serializePersistedPaneScope(
    scope: PaneScopeState,
    options: Readonly<{ preserveDesktopVisibility: boolean; previous?: PersistedPaneScope }>,
): PersistedPaneScope {
    // Phone sheets are interaction state. Keep the saved desktop visibility
    // while selections, retained tabs and their content still checkpoint normally.
    const { preserveDesktopVisibility, previous } = options;
    return {
        mainHidden: preserveDesktopVisibility ? previous?.mainHidden === true : scope.mainHidden,
        // Phone navigation has its own route/scene selection and leaves the desktop page intact.
        ...((preserveDesktopVisibility ? previous?.mainTabId : scope.mainTabId) === undefined ? {} : {
            mainTabId: preserveDesktopVisibility ? previous?.mainTabId : scope.mainTabId,
        }),
        right: {
            ...scope.right,
            isOpen: preserveDesktopVisibility ? previous?.right.isOpen === true : scope.right.isOpen,
            tabState: { ...scope.right.tabState },
        },
        details: {
            ...serializeDetailsWorkspaceState(scope.details),
            isOpen: preserveDesktopVisibility ? previous?.details.isOpen === true : scope.details.isOpen,
        },
        bottom: {
            ...scope.bottom,
            isOpen: preserveDesktopVisibility ? previous?.bottom.isOpen === true : scope.bottom.isOpen,
            tabState: { ...scope.bottom.tabState },
        },
    } satisfies PersistedPaneScope;
}
