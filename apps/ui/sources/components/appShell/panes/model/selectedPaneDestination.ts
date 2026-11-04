import {
    PluginUiDestinationReferenceV1Schema,
    type PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginUiInstanceKeyV1Schema,
    type PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui/semanticCommands';
import { z } from 'zod/mini';
import type { PaneScopeState } from './appPaneReducer';

const SELECTED_PANE_SLOTS = ['right', 'bottom', 'detailsOverlay'] as const;
export type SelectedPaneSlot = typeof SELECTED_PANE_SLOTS[number];
export type PaneSlotPresentation = Readonly<{ windowId: string }>;
export const PaneSlotPresentationSchema = z.object({ windowId: z.string() });
export type SelectedPaneSlotDescriptor = Readonly<{
    slot: SelectedPaneSlot;
    tabKey: string;
    resourceId: string;
    paneType: 'rightPane' | 'bottomPane' | 'detailsPane';
    destination: SelectedPaneDestinationV1;
    presentation?: PaneSlotPresentation;
}>;

/** Slots keep their address when an existing window is retargeted to another selection. */
export function selectedPaneDestinationTabKey(slot: SelectedPaneSlot): string {
    return JSON.stringify(['paneSlot', slot]);
}

export function readSelectedPaneDestinationSlot(tabKey: string): SelectedPaneSlot | null {
    for (const slot of SELECTED_PANE_SLOTS) {
        if (selectedPaneDestinationTabKey(slot) === tabKey) return slot;
    }
    return null;
}

export function isSelectedPaneDestinationTabKey(tabKey: string): boolean {
    return readSelectedPaneDestinationSlot(tabKey) !== null;
}

export function isSelectedPaneSlotVisible(
    state: Readonly<{ isOpen: boolean; presentation?: PaneSlotPresentation }> | undefined,
    slot: SelectedPaneSlot,
    selectedPaneTabKey?: string,
): boolean {
    if (selectedPaneTabKey !== undefined) return selectedPaneTabKey === selectedPaneDestinationTabKey(slot);
    return state?.isOpen === true && state.presentation === undefined;
}

export function selectedPaneDestinationResourceId(destination: SelectedPaneDestinationV1): string {
    return JSON.stringify(destination.kind === 'builtin' ? ['builtin', destination.id]
        : ['plugin', destination.destination.pluginId, destination.destination.localId, destination.instanceKey ?? null]);
}

export function enumerateSelectedPaneSlots(scope: PaneScopeState): readonly SelectedPaneSlotDescriptor[] {
    const slots: SelectedPaneSlotDescriptor[] = [];
    for (const slot of SELECTED_PANE_SLOTS) {
        if (slot === 'detailsOverlay') continue;
        const state = scope[slot];
        const destination = state.selectedDestination ?? (state.activeTabId ? createBuiltinPaneDestination(state.activeTabId) : null);
        if (!destination || (!state.isOpen && !state.presentation)) continue;
        slots.push({ slot, tabKey: selectedPaneDestinationTabKey(slot), resourceId: selectedPaneDestinationResourceId(destination),
            paneType: slot === 'right' ? 'rightPane' : 'bottomPane', destination,
            ...(state.presentation ? { presentation: state.presentation } : {}) });
    }
    if (scope.details.overlay) {
        const overlay = scope.details.overlay;
        const destination: SelectedPaneDestinationV1 = { kind: 'plugin', destination: overlay.destination,
            ...(overlay.instanceKey === undefined ? {} : { instanceKey: overlay.instanceKey }) };
        slots.push({ slot: 'detailsOverlay', tabKey: selectedPaneDestinationTabKey('detailsOverlay'),
            resourceId: selectedPaneDestinationResourceId(destination), paneType: 'detailsPane', destination,
            ...(overlay.presentation ? { presentation: overlay.presentation } : {}) });
    }
    return slots;
}

export function findSelectedPaneSlot(scope: PaneScopeState, tabKey: string): SelectedPaneSlotDescriptor | null {
    return enumerateSelectedPaneSlots(scope).find(slot => slot.tabKey === tabKey) ?? null;
}

/** A failed native retarget restores selection without undoing flushed drafts or sibling edits. */
export function restorePaneDestinationSelection(current: PaneScopeState, previous: PaneScopeState, tabKey: string): PaneScopeState {
    const slot = readSelectedPaneDestinationSlot(tabKey);
    if (slot === 'right' || slot === 'bottom') {
        return { ...current, [slot]: { ...previous[slot], tabState: current[slot].tabState } };
    }
    if (slot === 'detailsOverlay') {
        return { ...current, details: { ...current.details, overlay: previous.details.overlay } };
    }
    const previousTab = previous.details.tabsByKey[tabKey];
    return previousTab ? { ...current, details: { ...current.details,
        tabsByKey: { ...current.details.tabsByKey, [tabKey]: previousTab } } } : current;
}

/**
 * The durable selection identity for an AppPane slot.
 *
 * It deliberately carries only the host's built-in id or the Protocol-owned
 * qualified plugin destination plus an optional opaque instance key. Launch
 * input, projection generation, artifact identity and stamped runtime target
 * are current mount facts; persisting any of them would let stale authority
 * cross restoration.
 */
export type SelectedPaneDestinationV1 =
    | Readonly<{ kind: 'builtin'; id: string }>
    | Readonly<{
        kind: 'plugin';
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>;

const PaneBuiltinDestinationIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

/**
 * Zod persistence adapter over the Protocol-owned composable schema. It
 * delegates parsing and normalization to Protocol; AppPane owns only the
 * containing local-storage shape.
 */
export const PersistedPluginUiDestinationReferenceV1Schema = z.pipe(z.unknown(), z.transform((value, context) => {
    const parsed = PluginUiDestinationReferenceV1Schema.safeParse(value);
    if (parsed.success) return parsed.data;
    context.issues.push({ code: 'custom', message: 'Invalid plugin UI destination reference', input: context.value });
    return z.NEVER;
}));

export const SelectedPaneDestinationV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('builtin'),
        id: PaneBuiltinDestinationIdSchema,
    }),
    z.strictObject({
        kind: z.literal('plugin'),
        destination: PersistedPluginUiDestinationReferenceV1Schema,
        instanceKey: z.optional(PluginUiInstanceKeyV1Schema),
    }),
]);

export function createBuiltinPaneDestination(id: string): SelectedPaneDestinationV1 {
    return Object.freeze({ kind: 'builtin', id });
}

export function areSelectedPaneDestinationsEqual(
    left: SelectedPaneDestinationV1 | null,
    right: SelectedPaneDestinationV1 | null,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'builtin' && right.kind === 'builtin') {
        return left.id === right.id;
    }
    if (left.kind === 'plugin' && right.kind === 'plugin') {
        return left.destination.pluginId === right.destination.pluginId
            && left.destination.localId === right.destination.localId
            && left.instanceKey === right.instanceKey;
    }
    return false;
}
