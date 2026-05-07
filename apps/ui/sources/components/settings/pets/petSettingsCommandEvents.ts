type PetSettingsCommandListener = () => void;

const listeners = new Set<PetSettingsCommandListener>();
let pendingCodexPetRefresh = false;

export function requestCodexPetRefresh(): void {
    pendingCodexPetRefresh = true;
    for (const listener of listeners) listener();
}

export function consumePendingCodexPetRefresh(): boolean {
    if (!pendingCodexPetRefresh) return false;
    pendingCodexPetRefresh = false;
    return true;
}

export function subscribeCodexPetRefresh(listener: PetSettingsCommandListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
