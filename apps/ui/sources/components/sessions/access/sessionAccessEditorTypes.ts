import type { EffectiveSessionAccessLevelV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type { SessionAccessPrincipalSummaryV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import type { SessionAccessLevelV1 } from '@happier-dev/protocol/sessions/access/sessionAccessGrantV1';
import type { SessionBotTemplateSource } from '@/components/sessions/bots/templates/openBotTemplate';

import type { SessionAccessQuery } from './sessionAccessQuery';
import type { SessionCollaborationHandoff } from '@/components/sessions/collaboration/sessionCollaborationIntent';
import type {
    ShareAvatarPresentation, ShareCandidateRowModel, ShareDirectoryKind, ShareDirectorySectionModel, ShareGrantRowModel,
    ShareLevelControlModel, ShareOperationModel, ShareOwnerRowModel, SharePrincipalPresentation, ShareRemovalModel,
    ShareUiError, ShareUiReason,
    ShareSheetAdapter,
} from '@/components/sharing/shareSheetTypes';

export type SessionAccessPrincipalRef = PrincipalRefV1;
export type SessionAccessGrantRef = PrincipalRefV1;
export type SessionAccessLevel = SessionAccessLevelV1;
// The grant roster vocabulary is the one share sheet's (`components/sharing`). These names are the
// session adapter's view of it; only the fields below the roster are session-only.
export type SessionAccessUiReason = ShareUiReason;
export type SessionAccessUiError = ShareUiError;
export type SessionAccessAvatarPresentation = ShareAvatarPresentation;
export type SessionAccessPrincipalPresentation = SharePrincipalPresentation;
export type SessionAccessLevelControlModel = ShareLevelControlModel;
export type SessionAccessDelegationControlModel =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'editable'; value: boolean }>
    | Readonly<{ kind: 'locked'; value: boolean; reason: SessionAccessUiReason }>;
export type SessionAccessRemovalModel = ShareRemovalModel;
export type SessionAccessGrantOperationModel = ShareOperationModel;
export type SessionAccessOwnerRowModel = ShareOwnerRowModel;
export type SessionAccessGrantRowModel = ShareGrantRowModel & Readonly<{
    permissionDelegation: SessionAccessDelegationControlModel;
    requiredByTeamPolicy: boolean;
}>;
export type SessionAccessCandidateRowModel = ShareCandidateRowModel & Readonly<{
    /** Retain the authorized source so selected labels use the same local opener. */
    principalSummary?: SessionAccessPrincipalSummaryV1;
    teamMembership?: Readonly<{ teamId: string; teamMembershipId: string; accountId: string }>;
    teamGroup?: Readonly<{ teamId: string; teamGroupId: string }>;
}>;
export type SessionAccessDirectoryKind = ShareDirectoryKind;
export type SessionAccessDirectorySectionModel = Omit<ShareDirectorySectionModel, 'candidates' | 'resolveCandidates'> & Readonly<{
    candidates: readonly SessionAccessCandidateRowModel[];
    resolveCandidates?: (query: string, signal: AbortSignal) => Promise<readonly SessionAccessCandidateRowModel[]>;
}>;
/** The typed text is not part of the model: it lives in the controller's `SessionAccessQuery`. */
export type SessionAccessDirectoryModel = Readonly<{ sections: readonly SessionAccessDirectorySectionModel[] }>;
export type SessionAccessSummaryPresentation = Readonly<{ label: string; accessibilityLabel: string; requiredByTeamPolicy: boolean }>;
/**
 * Safe presentation of the current Account's server-admitted access.
 *
 * Source labels deliberately carry no grant, Team, Group, or Account identifiers.
 * A non-manager may inspect the reason their own Session is reachable without
 * receiving the private grant roster that remains manager-only.
 */
export type SessionAccessViewerPresentation = Readonly<{
    level: EffectiveSessionAccessLevelV1;
    levelLabel: string;
    sourceLabels: readonly string[];
    accessibilityLabel: string;
}>;
export type SessionAccessContextOption = Readonly<{
    teamId: string | null;
    label: string;
    blockedReason?: SessionAccessUiReason;
}>;
export type SessionAccessContextModel = Readonly<{
    primaryTeamId: string | null;
    options: readonly SessionAccessContextOption[];
    /** The Home's current sharing-policy refusal, or an explanation while it cannot be checked. */
    unavailableReason?: SessionAccessUiReason;
    operation?: 'idle' | 'saving' | 'error';
    error?: SessionAccessUiError;
    confirmation?: Readonly<{
        teamId: string | null;
        label: string;
        consequences: readonly string[];
    }>;
}>;
export type SessionAccessEditorNotice = Readonly<{
    message: string;
    reason?: SessionAccessUiReason;
    action?: 'clear_access';
}>;

/** What the Home says about one authorized Account's ability to open this Session. */
export type SessionAccessEncryptionRecipientState =
    | 'prepared'
    | 'pending'
    | 'invalid'
    | 'plain_account'
    | 'encryption_setup_required'
    | 'encryption_inconsistent';
export type SessionAccessEncryptionRecipientRowModel = Readonly<{
    recipientAccountId: string;
    state: SessionAccessEncryptionRecipientState;
    label: string;
    stateLabel: string;
    accessibilityLabel: string;
    /** Present only on a row a repeated delivery could actually change. */
    actionLabel?: string;
}>;
/**
 * Which rows are listed beneath the aggregate: the exceptions discovery already
 * fetched (the default), or the explicit `Show all people` view paged on demand
 * through the same authorized collection.
 */
export type SessionAccessEncryptionRecipientsView = 'exceptions' | 'all';
/**
 * The rows beneath the aggregate. Absent while the default view has nothing to
 * name, so a healthy audience stays one quiet line and the editor never loads
 * people it does not need.
 */
export type SessionAccessEncryptionRecipientsModel = Readonly<{
    rows: readonly SessionAccessEncryptionRecipientRowModel[];
    hasMore: boolean;
    loading: boolean;
    error?: SessionAccessUiError;
}>;
/**
 * One Session-scoped encryption aggregate, never a per-grant census.
 *
 * Every count is the Home's own summary for the whole authorized audience: a Team
 * grant is one row and many Accounts, so a locally recomputed number would be a
 * quieter untruth than showing none.
 */
/**
 * The material state of this Session's encrypted access, as the one projector decides it.
 *
 * It exists so a surface can tell a transition from a repaint without re-deriving it from
 * copy or counts: progress ticks and later recipient pages keep the same key, while
 * `preparing → ready` is the change a screen reader must hear about.
 */
export type SessionAccessEncryptionStatusKey =
    'preparing' | 'ready' | 'needs_attention' | 'failed' | 'unavailable';
export type SessionAccessEncryptionModel = Readonly<{
    statusKey: SessionAccessEncryptionStatusKey;
    /**
     * What to say when this state is *reached*. Absent while a state is still moving,
     * so a live region never reads a count that is about to change.
     */
    announcement?: string;
    /** `42 prepared · 3 pending · 1 needs setup or repair`, or the quiet ready line. */
    summaryLabel: string;
    accessibilityLabel: string;
    /** Determinate committed progress; present only while this client is preparing. */
    progressLabel?: string;
    /** `Prepare now` / `Prepare again`; absent when this device can do nothing. */
    actionLabel?: string;
    reason?: SessionAccessUiReason;
    error?: SessionAccessUiError;
    showAllLabel: string;
    recipientsView: SessionAccessEncryptionRecipientsView;
    recipients?: SessionAccessEncryptionRecipientsModel;
}>;
export type SessionAccessEditorModel = Readonly<{
    revision: string | number;
    accessMode: 'editable' | 'read_only';
    readOnlyReason?: SessionAccessUiReason;
    content: Readonly<{ phase: 'initial' | 'ready' | 'refreshing' | 'error'; hasLastAcknowledgedSnapshot: boolean; issue?: SessionAccessUiError }>;
    owner: SessionAccessOwnerRowModel | null;
    viewerAccess?: SessionAccessViewerPresentation;
    grants: readonly SessionAccessGrantRowModel[];
    directory: SessionAccessDirectoryModel;
    summary: SessionAccessSummaryPresentation;
    context?: SessionAccessContextModel;
    notice?: SessionAccessEditorNotice;
    encryption?: SessionAccessEncryptionModel;
    /**
     * The one access change the canonical Action policy routed to an approval
     * Artifact. Nothing has committed; the editor holds further edits until the
     * shared approval continuation settles it, exactly like the Board.
     */
    pendingApproval?: Readonly<{ artifactId: string; serverId: string }>;
    /**
     * Present only to the owner of a historical (layout-0) Session: the people and
     * links it is shared with cannot open it until the owner updates it (PA-L2).
     */
    historicalLayout?: Readonly<{ updating: boolean; error?: SessionAccessUiError }>;
}>;
export type SessionAccessEditorActions = Readonly<{
    setQuery(query: string): void;
    retryContent(): void;
    retryDirectory(kind: SessionAccessDirectoryKind): void;
    loadMore(kind: SessionAccessDirectoryKind): void;
    addPrincipal(principal: SessionAccessPrincipalRef): void;
    /** Retries the exact acknowledged-or-unknown mutation represented by this row. */
    retryMutation(grant: SessionAccessGrantRef): void;
    setAccessLevel(grant: SessionAccessGrantRef, level: SessionAccessLevel): void;
    setPermissionDelegation(grant: SessionAccessGrantRef, enabled: boolean): void;
    requestRemove(grant: SessionAccessGrantRef): void;
    confirmRemove(grant: SessionAccessGrantRef): void;
    cancelRemove(grant: SessionAccessGrantRef): void;
    explain(reason: SessionAccessUiReason): void;
    setContext(teamId: string | null): void;
    confirmContext(): void;
    cancelContext(): void;
    clearAccess(): void;
    prepareAccess(recipientAccountId?: string): void;
    /** Opens or closes the explicit `state=all` recipient diagnostic. */
    toggleAllRecipients(): void;
    /** Pages the open diagnostic through the collection's own cursor. */
    loadMoreRecipients(): void;
    /** Opens the pending approval where it is decided; live editors only. */
    openPendingApproval?(): void;
    /** The owner's deliberate update of a historical Session for sharing; live editors only. */
    updateHistoricalLayout?(): void;
}>;
export type SessionAccessEditorController = Readonly<{
    model: SessionAccessEditorModel;
    actions: SessionAccessEditorActions;
    /** The one owner of the typed search; `actions.setQuery` writes it, the editor subscribes. */
    query: SessionAccessQuery;
}>;
export type SessionAccessEditorPresentation = 'compact' | 'full';
export type SessionAccessEditorProps = Readonly<{
    /** The controller's typed search; absent for a fixed presentation, which shows an empty field. */
    query?: SessionAccessQuery;
    model: SessionAccessEditorModel;
    actions: SessionAccessEditorActions;
    presentation: SessionAccessEditorPresentation;
    onRequestClose?: () => void;
    /**
     * Supplied only by an anchored compact host that can hand off to the full
     * Collaboration surface with Access focused. Absent everywhere the editor is
     * already the full surface, so it never offers to open itself. It carries
     * the root-step query, which is the only state the destination's own
     * controller cannot rebuild for itself.
     */
    onOpenFullSurface?: (handoff: SessionCollaborationHandoff) => void;
    /** The Session's in-app route for Copy link; absent before the Session exists. */
    linkPath?: string;
    /** Publication state and controls supplied by the Collaboration pane's one controller. */
    publicLink?: ShareSheetAdapter['publicLink'];
    /** A consumed host intent to open a row in the sheet's own expansion owner. */
    openRowRequest?: Readonly<{ key: string }>;
    /** The Session's responsible Account, tagged where its access is listed (Share panel). */
    responsibleAccountId?: string | null;
    /** Existing Bot snapshot; the template entry owner decides whether the person can draft/reopen. */
    templateSource?: Readonly<{ session: SessionBotTemplateSource; serverId: string }>;
    testID?: string;
}>;
