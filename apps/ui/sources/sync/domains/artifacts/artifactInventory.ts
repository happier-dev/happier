import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { deriveApprovalArtifactQueryHintsV1, isApprovalArtifactKindV1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { INBOX_ARTIFACT_KINDS } from './inboxArtifacts';
import type { ArtifactListSelectionOptionsV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import type { DecryptedArtifact } from './artifactTypes';

export type ArtifactInventoryView = 'browserListed' | 'promptLibrary';

/** Unknown opaque classification is shared by local projection and absence reconciliation. */
export function readArtifactBrowserMembership(artifact: DecryptedArtifact): boolean | null {
    const header = artifact.rawHeader ?? artifact.header;
    if (header) return doesArtifactInventorySelectionMatchHeader('browserListed', header);
    return Object.hasOwn(artifact, 'kindHint') && artifact.kindHint !== undefined
        ? getArtifactKindPolicyV1(artifact.kindHint).browserListed : null;
}

/** Local membership follows the query owner, retaining unresolved candidates truthfully. */
export function doesArtifactInventoryViewMatchRow(view: ArtifactInventoryView, artifact: DecryptedArtifact): boolean {
    if (artifact.draft) return false;
    if (view === 'browserListed') return readArtifactBrowserMembership(artifact) !== false;
    const header = artifact.rawHeader ?? artifact.header;
    if (header) return doesArtifactInventorySelectionMatchHeader(PROMPT_LIBRARY_ARTIFACT_KINDS, header);
    if (!Object.hasOwn(artifact, 'kindHint') || artifact.kindHint === undefined) return true;
    return typeof artifact.kindHint === 'string' && PROMPT_LIBRARY_ARTIFACT_KINDS.includes(artifact.kindHint);
}

/** Omitted selects the full Account census; browser membership includes unknown ordinary kinds. */
export type ArtifactInventorySelection = readonly string[] | 'browserListed' | 'inboxOpen'
    | Readonly<{ approvalSessionIds: readonly string[] }>
    | Readonly<{ kinds: readonly string[]; approvalStates: readonly ApprovalArtifactStateV1[] }>;

export function isApprovalSessionInventorySelection(selection: ArtifactInventorySelection | undefined): selection is Readonly<{ approvalSessionIds: readonly string[] }> {
    return typeof selection === 'object' && 'approvalSessionIds' in selection;
}

export function isApprovalStateInventorySelection(selection: ArtifactInventorySelection | undefined): selection is Readonly<{ kinds: readonly string[]; approvalStates: readonly ApprovalArtifactStateV1[] }> {
    return typeof selection === 'object' && 'approvalStates' in selection;
}

/** Every surface and reconnect refresh uses the same query selection. */
export function artifactInventorySelectionOptions(selection?: ArtifactInventorySelection): Pick<ArtifactListSelectionOptionsV1,
    'kinds' | 'browserListed' | 'approvalStates' | 'approvalSessionIds'> {
    if (selection === 'browserListed') return { browserListed: true };
    if (selection === 'inboxOpen') return { kinds: INBOX_ARTIFACT_KINDS, approvalStates: ['open'] };
    if (isApprovalSessionInventorySelection(selection) || isApprovalStateInventorySelection(selection)) return selection;
    return { kinds: selection };
}

/** Reconcile only the members whose absence this acquisition can establish. */
export function doesArtifactInventorySelectionMatchHeader(selection: ArtifactInventorySelection | undefined,
    header: Readonly<Record<string, unknown>>): boolean {
    if (selection === undefined) return true;
    if (selection === 'browserListed') return getArtifactKindPolicyV1(header.kind).browserListed;
    const hints = selection === 'inboxOpen' || isApprovalSessionInventorySelection(selection) || isApprovalStateInventorySelection(selection)
        ? deriveApprovalArtifactQueryHintsV1(header) : null;
    if (selection === 'inboxOpen') return typeof header.kind === 'string' && INBOX_ARTIFACT_KINDS.includes(header.kind)
        && (hints?.approvalState === 'open' || !isApprovalArtifactKindV1(header.kind));
    if (isApprovalSessionInventorySelection(selection)) return hints?.approvalSessionId !== null
        && hints?.approvalSessionId !== undefined && selection.approvalSessionIds.includes(hints.approvalSessionId);
    if (isApprovalStateInventorySelection(selection)) return typeof header.kind === 'string' && selection.kinds.includes(header.kind)
        && hints?.approvalState !== null && hints?.approvalState !== undefined && selection.approvalStates.includes(hints.approvalState);
    return typeof header.kind === 'string' && selection.includes(header.kind);
}

/** Selection containment is shared by the inventory's queue and its admitted store facts. */
export function doesArtifactInventorySelectionCover(acquired: ArtifactInventorySelection | undefined,
    requested: ArtifactInventorySelection | undefined): boolean {
    if (acquired === undefined) return true;
    if (requested === undefined) return false;
    if (isApprovalSessionInventorySelection(acquired)) return isApprovalSessionInventorySelection(requested)
        && requested.approvalSessionIds.every(id => acquired.approvalSessionIds.includes(id));
    if (isApprovalStateInventorySelection(acquired)) return isApprovalStateInventorySelection(requested)
        && requested.kinds.every(kind => acquired.kinds.includes(kind))
        && requested.approvalStates.every(state => acquired.approvalStates.includes(state));
    if (acquired === 'inboxOpen') return requested === 'inboxOpen';
    if (isApprovalSessionInventorySelection(requested)) return false;
    if (isApprovalStateInventorySelection(requested)) return acquired !== 'browserListed'
        && requested.kinds.every(kind => acquired.includes(kind));
    if (requested === 'inboxOpen') return acquired !== 'browserListed' && INBOX_ARTIFACT_KINDS.every(kind => acquired.includes(kind));
    if (acquired === 'browserListed') return requested === 'browserListed'
        || requested.every(kind => getArtifactKindPolicyV1(kind).browserListed);
    return requested !== 'browserListed' && requested.every(kind => acquired.includes(kind));
}

/** Prompt collections, Context entries and the shared prompt-folder tree render these header kinds. */
export const PROMPT_LIBRARY_ARTIFACT_KINDS: readonly string[] = Object.freeze([
    'memory_doc.v1', 'prompt_bundle.v2', 'prompt_doc.v2',
]);

/** Exhausted reads reconcile structural absence; only readable inventory certifies kind classification. */
export type ArtifactInventoryPublication = 'inventory' | 'partial' | 'unreadable';

/** Full membership and exact-kind membership are facts of the same admitted Artifact projection. */
export function isArtifactInventoryLoaded(state: Readonly<{
    artifactsLoaded: boolean;
    artifactBrowserLoaded?: boolean;
    artifactInboxLoaded?: boolean;
    artifactInventoryKindsLoaded: readonly string[];
}>, selection?: ArtifactInventorySelection): boolean {
    if (selection === 'browserListed') return state.artifactBrowserLoaded === true;
    if (isApprovalSessionInventorySelection(selection) || isApprovalStateInventorySelection(selection)) return state.artifactsLoaded;
    if (selection === 'inboxOpen') return state.artifactsLoaded || state.artifactInboxLoaded === true
        || INBOX_ARTIFACT_KINDS.every(kind => state.artifactInventoryKindsLoaded.includes(kind));
    return state.artifactsLoaded || (selection !== undefined && (
        doesArtifactInventorySelectionCover(state.artifactInventoryKindsLoaded, selection)
        || (state.artifactBrowserLoaded === true && doesArtifactInventorySelectionCover('browserListed', selection))));
}

/** Like a full inventory with locked rows, an exhausted opaque read can render without certifying classification. */
export function isArtifactInventoryReady(state: Readonly<{
    artifactsLoaded: boolean;
    artifactBrowserLoaded?: boolean;
    artifactInboxLoaded?: boolean;
    artifactInboxPartial?: boolean;
    artifactInventoryKindsLoaded: readonly string[];
    artifactInventoryKindsPartial: readonly string[];
}>, selection?: ArtifactInventorySelection): boolean {
    if (selection === 'inboxOpen') return isArtifactInventoryLoaded(state, selection) || state.artifactInboxPartial === true;
    if (isApprovalSessionInventorySelection(selection) || isApprovalStateInventorySelection(selection)) return state.artifactsLoaded;
    return isArtifactInventoryLoaded(state, selection) || (selection !== undefined && selection !== 'browserListed' && selection.every(kind =>
        state.artifactInventoryKindsLoaded.includes(kind) || state.artifactInventoryKindsPartial.includes(kind)));
}
