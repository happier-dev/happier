export type SessionListSelectionKey = string;

export type SessionListSelectionSnapshot = Readonly<{
    isSelectionMode: boolean;
    selectedKeys: ReadonlySet<SessionListSelectionKey>;
    anchorKey: SessionListSelectionKey | null;
    focusedKey: SessionListSelectionKey | null;
    visibleOrderedKeys: readonly SessionListSelectionKey[];
    eligibleKeys: ReadonlySet<SessionListSelectionKey>;
    scopeKey: string;
    version: number;
    count: number;
}>;

export type SessionListSelectionState = Readonly<{
    isSelectionMode: boolean;
    selectedKeys: ReadonlySet<SessionListSelectionKey>;
    anchorKey: SessionListSelectionKey | null;
    focusedKey: SessionListSelectionKey | null;
    visibleOrderedKeys: readonly SessionListSelectionKey[];
    eligibleKeys: ReadonlySet<SessionListSelectionKey>;
    scopeKey: string;
    version: number;
}>;

export type SessionListSelectionActions = Readonly<{
    enter: (preselectKey?: SessionListSelectionKey | null) => void;
    exit: () => void;
    clear: () => void;
    replaceWith: (key: SessionListSelectionKey) => void;
    toggle: (key: SessionListSelectionKey) => void;
    selectRange: (targetKey: SessionListSelectionKey) => void;
    addRange: (targetKey: SessionListSelectionKey) => void;
    selectAllVisible: () => void;
    setSelectedKeys: (keys: readonly SessionListSelectionKey[]) => void;
    setFocusedKey: (key: SessionListSelectionKey | null) => void;
    isSelected: (key: SessionListSelectionKey) => boolean;
}>;

export type SessionListSelectionStore = SessionListSelectionActions & Readonly<{
    getSnapshot: () => SessionListSelectionSnapshot;
    getRowSnapshot: (key: SessionListSelectionKey) => string;
    subscribe: (listener: () => void) => () => void;
    updateScope: (params: Readonly<{
        scopeKey: string;
        visibleOrderedKeys: readonly SessionListSelectionKey[];
        eligibleKeys?: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null;
    }>) => void;
}>;
