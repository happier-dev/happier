import type { ReactNode } from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

/**
 * The one share sheet's vocabulary. Every shareable thing (a session, a workflow, a role, a
 * launch profile) uses the same level vocabulary and principals. The adapter declares its supported
 * subset and what each level means; the sheet carries values and asks its adapter for words.
 */
export type ShareAccessLevel = 'view' | 'edit' | 'admin';
/** The one level order every sheet shows, whatever order an owner or a server returns. */
export const SHARE_ACCESS_LEVEL_ORDER: readonly ShareAccessLevel[] = ['view', 'edit', 'admin'];

export type ShareUiReason = Readonly<{ code: string; message: string }>;
export type ShareUiError = ShareUiReason & Readonly<{ retryable: boolean }>;
/**
 * Inputs for the canonical `Avatar` owner, not a second avatar model. Teams and Groups carry no
 * Account profile and are drawn with their kind glyph instead.
 */
export type ShareAvatarPresentation = Readonly<{ id: string; imageUrl?: string }>;
export type SharePrincipalPresentation = Readonly<{
    ref: PrincipalRefV1;
    key: string;
    displayName: string;
    secondaryLabel?: string;
    avatar?: ShareAvatarPresentation;
    accessibilityLabel: string;
}>;
export type ShareLevelControlModel =
    | Readonly<{ kind: 'editable'; value: ShareAccessLevel; options: readonly ShareAccessLevel[] }>
    | Readonly<{ kind: 'locked'; value: ShareAccessLevel; reason: ShareUiReason }>;
export type ShareRemovalModel =
    | Readonly<{ kind: 'allowed' }>
    /** `consequences` are the owner's own preview of what this removal breaks; empty when none. */
    | Readonly<{ kind: 'confirming'; consequences: readonly string[] }>
    | Readonly<{ kind: 'blocked'; reason: ShareUiReason }>;
export type ShareOperationModel =
    | Readonly<{ kind: 'idle' | 'saving' | 'removing' }>
    | Readonly<{ kind: 'error'; error: ShareUiError }>;
export type ShareOwnerRowModel = Readonly<{ principal: SharePrincipalPresentation }>;
export type ShareGrantRowModel = Readonly<{
    grant: PrincipalRefV1;
    principal: SharePrincipalPresentation;
    level: ShareLevelControlModel;
    removal: ShareRemovalModel;
    operation: ShareOperationModel;
}>;
export type ShareCandidateRowModel = Readonly<{
    principal: SharePrincipalPresentation;
    addition: Readonly<{ kind: 'allowed' }> | Readonly<{ kind: 'blocked'; reason: ShareUiReason }>;
    operation: ShareOperationModel;
}>;
export type ShareDirectoryKind = PrincipalRefV1['kind'];
export type ShareDirectorySectionModel = Readonly<{
    kind: ShareDirectoryKind;
    title: string;
    candidates: readonly ShareCandidateRowModel[];
    status: 'idle' | 'loading' | 'refreshing' | 'error';
    /** Whether the directory owner has answered its initial lookup. Fixed lists are already resolved. */
    resolved?: boolean;
    error?: ShareUiError;
    cursor: string | null;
    hasMore: boolean;
    loadingMore: boolean;
    resolverKey?: string;
    resolveCandidates?: (query: string, signal: AbortSignal) => Promise<readonly ShareCandidateRowModel[]>;
}>;
export type ShareDirectoryModel = Readonly<{ query: string; sections: readonly ShareDirectorySectionModel[] }>;

/** What the sheet renders: who has access now, and who can still be added. */
export type ShareSheetModel<TRow extends ShareGrantRowModel = ShareGrantRowModel> = Readonly<{
    revision: string | number;
    /** Local selections await the host's write; removing one does not yet revoke access. */
    draft?: true;
    /** Whether this viewer may change the roster right now; the adapter decides why not. */
    editable: boolean;
    /** Last-good rows kept while the owner is unreachable; they must not read as current. */
    stale: boolean;
    owner: ShareOwnerRowModel | null;
    grants: readonly TRow[];
    directory: ShareDirectoryModel;
}>;

/** The roster intents every sheet offers; each adapter's controller owns how they are written. */
export type ShareSheetActions = Readonly<{
    setQuery(query: string): void;
    retryDirectory(kind: ShareDirectoryKind): void;
    loadMore(kind: ShareDirectoryKind): void;
    addPrincipal(principal: PrincipalRefV1): void;
    /** Retries the exact mutation this row represents. */
    retryMutation(grant: PrincipalRefV1): void;
    setAccessLevel(grant: PrincipalRefV1, level: ShareAccessLevel): void;
    requestRemove(grant: PrincipalRefV1): void;
    confirmRemove(grant: PrincipalRefV1): void;
    cancelRemove(grant: PrincipalRefV1): void;
    explain(reason: ShareUiReason): void;
}>;

export type ShareLevelPresentation = Readonly<{ label: string; help?: string }>;

/** Rendering context the sheet hands to an adapter's own sections. */
export type ShareSheetSectionContext = Readonly<{
    /** Prefix for every testID this sheet renders (empty for the default host). */
    idPrefix: string;
    editable: boolean;
    directoryKind?: ShareDirectoryKind;
    /**
     * Whether people still to add are listed: always in a compact popover, and once someone starts
     * adding (field focused or a query typed) in an inline sheet. Adapters reveal their own candidates
     * with them so one search adds everyone.
     */
    revealSuggestions?: boolean;
    onExpand(key: string): void;
}>;

export type ShareGrantRowAdapter<TRow extends ShareGrantRowModel = ShareGrantRowModel> = Readonly<{
  namespace: string;
  levels: Readonly<Partial<Record<ShareAccessLevel, ShareLevelPresentation>>>;
  showsLevelLock?: (row: TRow) => boolean;
  renderGrantDetails?: (row: TRow, context: ShareSheetSectionContext) => ReactNode;
  removalLabels?: (row: TRow) => Readonly<{ request: string; confirm: string }> | undefined;
}>;
