import type { ReactNode } from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol';

import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';

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
    onExpand(key: string): void;
}>;
export type ShareSheetAdapterSections = Readonly<{
    /** Above "Who has access" (for example the viewer's own access). */
    leading?: readonly SelectionListSectionDescriptor[];
    /** Between "Who has access" and the people still to add. */
    afterAccess?: readonly SelectionListSectionDescriptor[];
    /** After the people still to add: the adapter's notices and hand-offs. */
    trailing?: readonly SelectionListSectionDescriptor[];
}>;

/**
 * The meaning of one shareable thing. The sheet owns the layout, adding people or Teams, the
 * level order, "Who has access", Copy link and Send a copy instead; the adapter owns the words and
 * anything only its domain has.
 */
export type ShareSheetAdapter<TRow extends ShareGrantRowModel = ShareGrantRowModel> = Readonly<{
    /** testID and list-step namespace, for example `session-access` or `document-share`. */
    namespace: string;
    /** The list's accessible name. */
    title: string;
    /** Only levels the domain actually accepts. The sheet never invents missing levels. */
    levels: Readonly<Partial<Record<ShareAccessLevel, ShareLevelPresentation>>>;
    /** The domain's sharing rules, one sentence each. */
    notes?: readonly string[];
    /** The in-app route Copy link copies; absent when the thing has no link yet. */
    linkPath?: string;
    /** The common public-link row; each domain supplies its current state and its existing editor. */
    publicLink?: Readonly<{
        stateLabel: string;
        onOpen?: () => void;
        renderContent?: (context: ShareSheetSectionContext) => ReactNode;
    }>;
    /** Hands the person a copy instead of access. */
    sendCopy?: () => void;
    /** Extra subtitle words for a principal (for example "Responsible"). */
    principalTags?: (principal: SharePrincipalPresentation, row?: TRow) => readonly string[];
    /** Whether the row's level is locked by a policy the person can't change here. */
    showsLevelLock?: (row: TRow) => boolean;
    /** Domain controls inside an expanded grant row. */
    renderGrantDetails?: (row: TRow, context: ShareSheetSectionContext) => ReactNode;
    /** Domain words for the same two-step row removal (for example leaving one's own share). */
    removalLabels?: (row: TRow) => Readonly<{ request: string; confirm: string }> | undefined;
    sections?: (context: ShareSheetSectionContext) => ShareSheetAdapterSections;
    /** Safety disclosure needed before adding from a pushed directory, not only the root roster. */
    showLeadingOnDirectorySteps?: boolean;
}>;

/**
 * `compact`: a popover; `full`: a page or sheet that fills its viewport and shows the level
 * meanings; `inline`: embedded in a host's own form, at its natural height, never taking focus.
 */
export type ShareSheetPresentation = 'compact' | 'full' | 'inline';
