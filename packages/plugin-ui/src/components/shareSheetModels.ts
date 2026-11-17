import type { ReactNode } from 'react';
import type { SelectionListSectionDescriptor } from './shareSelectionListTypes.js';
import type { ShareAccessLevel, ShareGrantRowModel, ShareLevelPresentation, SharePrincipalPresentation, ShareSheetSectionContext } from './shareGrantModels.js';

export type ShareSheetAdapterSections<TInvocation = unknown> = Readonly<{
    /** Above "Who has access" (for example the viewer's own access). */
    leading?: readonly SelectionListSectionDescriptor<TInvocation>[];
    /** Between "Who has access" and the people still to add. */
    afterAccess?: readonly SelectionListSectionDescriptor<TInvocation>[];
    /** After the people still to add: the adapter's notices and hand-offs. */
    trailing?: readonly SelectionListSectionDescriptor<TInvocation>[];
}>;

/**
 * The meaning of one shareable thing. The sheet owns the layout, adding people or Teams, the
 * level order, "Who has access", Copy link and Send a copy instead; the adapter owns the words and
 * anything only its domain has.
 */
export type ShareSheetAdapter<TRow extends ShareGrantRowModel = ShareGrantRowModel, TInvocation = unknown> = Readonly<{
    /** testID and list-step namespace, for example `session-access` or `document-share`. */
    namespace: string;
    /** The list's accessible name. */
    title: string;
    /** The item's owner explains what sharing this item gives the recipient. */
    description?: string;
    /** The consequence of adding someone, in one line beside Done (full presentation). */
    footnote?: string;
    /** The add field's words when this domain adds more than people and Teams (for example agents). */
    searchPlaceholder?: string;
    /** Only levels the domain actually accepts. The sheet never invents missing levels. */
    levels: Readonly<Partial<Record<ShareAccessLevel, ShareLevelPresentation>>>;
    /** The domain's sharing rules, one sentence each. */
    notes?: readonly string[];
    /** The in-app route Copy link copies; absent when the thing has no link yet. */
    linkPath?: string;
    /** The common public-link row; each domain supplies its current state and its existing editor. */
    publicLink?: Readonly<{
        label?: string;
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
    sections?: (context: ShareSheetSectionContext) => ShareSheetAdapterSections<TInvocation>;
    /** Safety disclosure needed before adding from a pushed directory, not only the root roster. */
    showLeadingOnDirectorySteps?: boolean;
    /**
     * An inline sheet whose roster is the content (a Discussion's participants): its search field is
     * the way to add, so the Browse entries wait until someone starts adding instead of trailing it.
     */
    browseOnlyWhileAdding?: boolean;
}>;

/**
 * `compact`: a popover; `full`: a page or sheet that fills its viewport and shows the level
 * meanings; `inline`: embedded in a host's own form, at its natural height, never taking focus.
 */
export type ShareSheetPresentation = 'compact' | 'full' | 'inline';
