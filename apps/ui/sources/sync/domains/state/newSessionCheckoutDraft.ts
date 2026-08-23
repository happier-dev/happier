export interface NewSessionCheckoutCreationDraft {
    kind: 'git_worktree';
    displayName: string;
    baseRef: string | null;
    branchMode?: 'new' | 'existing';
}

export interface NewSessionCheckoutDraft {
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
}

export interface NewSessionCheckoutSelection extends NewSessionCheckoutDraft {
    explicit: boolean;
}

function normalizeNullableString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeBranchMode(value: unknown): 'new' | 'existing' {
    return value === 'existing' ? 'existing' : 'new';
}

export function parseCheckoutCreationDraft(value: unknown): NewSessionCheckoutCreationDraft | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const kind = (value as { kind?: unknown }).kind;
    if (kind !== 'git_worktree') return null;

    const displayName = normalizeNullableString((value as { displayName?: unknown }).displayName);
    if (!displayName) return null;

    return {
        kind: 'git_worktree',
        displayName,
        baseRef: normalizeNullableString((value as { baseRef?: unknown }).baseRef),
        branchMode: normalizeBranchMode((value as { branchMode?: unknown }).branchMode),
    };
}

export function parseNewSessionCheckoutDraft(value: unknown): NewSessionCheckoutDraft {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
        checkoutCreationDraft: parseCheckoutCreationDraft(record.checkoutCreationDraft),
    };
}

export function hasExplicitNewSessionCheckoutSelection(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'checkoutCreationDraft')) return false;
    return record.checkoutCreationDraft === null || parseCheckoutCreationDraft(record.checkoutCreationDraft) !== null;
}

export function resolveNewSessionCheckoutSelection(
    ...sources: readonly unknown[]
): NewSessionCheckoutSelection {
    for (const source of sources) {
        if (!hasExplicitNewSessionCheckoutSelection(source)) continue;
        return {
            checkoutCreationDraft: parseNewSessionCheckoutDraft(source).checkoutCreationDraft,
            explicit: true,
        };
    }

    return {
        checkoutCreationDraft: null,
        explicit: false,
    };
}

export function readPersistedNewSessionCheckoutDraft(draft: unknown): NewSessionCheckoutDraft {
    return parseNewSessionCheckoutDraft(draft);
}
