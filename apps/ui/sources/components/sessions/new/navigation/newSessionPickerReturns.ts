/**
 * Picker results on their way back to the composer that opened the picker, keyed by that composer's draft id
 * (owner ruling 2026-11-13 15:07Z: one return owner keyed by the originating draft, docked or inline). A result
 * waits here until the host holding that draft takes it: at once while it is mounted, or when it mounts again after
 * its pane steps back. A result for a draft that never comes back stays until the app reloads.
 */
type PickerReturn = Readonly<Record<string, unknown>>;

const held = new Map<string, PickerReturn>();
const listeners = new Set<() => void>();

export function holdNewSessionPickerReturn(draftId: string, patch: PickerReturn): void {
    held.set(draftId, { ...held.get(draftId), ...patch });
    for (const listener of listeners) listener();
}

export function takeNewSessionPickerReturn(draftId: string): PickerReturn | null {
    const patch = held.get(draftId);
    if (!patch) return null;
    held.delete(draftId);
    return patch;
}

export function subscribeNewSessionPickerReturns(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

let ordinaryOrigin: string | null = null;

/**
 * The page's ordinary composer (Home) opened a picker on this draft. Its pane steps away from Home, so Home remounts
 * when the picker returns; an untouched ordinary draft is not remembered, so the next mount resumes this one.
 */
export function noteOrdinaryNewSessionPickerOrigin(draftId: string): void {
    ordinaryOrigin = draftId;
}

export function readOrdinaryNewSessionPickerOrigin(): string | null {
    return ordinaryOrigin;
}

export function clearOrdinaryNewSessionPickerOrigin(draftId: string): void {
    if (ordinaryOrigin === draftId) ordinaryOrigin = null;
}
