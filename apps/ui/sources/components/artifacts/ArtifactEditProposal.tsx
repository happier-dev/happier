import * as React from 'react';
import {
  HappierDocEditProposal,
  type HappierDocEditProposalButtonProps,
  type HappierDocEditProposalDiffProps,
  type HappierDocEditProposalLine,
  type HappierDocEditProposalMark,
  type HappierDocEditProposalMarkProps,
  type HappierDocEditProposalState,
  type HappierDocEditProposalTextProps,
  type HappierDocEditProposalTone,
} from '@happier-dev/plugin-ui/components';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DocEditProposalV1, DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DocEditProposeResolvedInputV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import type { DocEditProposalDispositionV1 } from '@happier-dev/protocol/discussions/models';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { buildDiscussionAccountMentionPayload } from '@/components/discussions/discussionComposerDocument';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionComposerSnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Text } from '@/components/ui/text/Text';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { readViewportClass } from '@/utils/platform/useViewportClass';
import { readArtifactActionFailure, type ArtifactActionFailure, type ArtifactActionsClient } from './artifactActionsClient';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { docProposalChangesOutsideSelection, readDocProposalSelection } from './docProposalSelection';
import {
  admitDocEditOperation, docEditOperationKey, holdDocEditApproval, readDocEditOperation, releaseDocEditOperation, settleDocEditUndo,
  useDocEditOperation, useDocEditRestoredVersion, type DocEditOperationKind,
} from './docEditOperation';

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Currency = 'unknown' | 'current' | 'movedOn';
type Busy = 'accept' | 'decline' | 'undo' | null;
type UndoOutcome = Readonly<{ state: 'done'; revision: Revision }>
  | Readonly<{ state: 'conflict' }>
  | Readonly<{ state: 'failed'; failure: ArtifactActionFailure }>;
type DocReadValue = Extract<Awaited<ReturnType<ArtifactActionsClient['readDoc']>>, { ok: true }>['value'];
export type AdmittedDocRead = Readonly<{ status: 'loading' | 'unavailable' }>
  | Readonly<{ status: 'ready'; value: DocReadValue }>;

const DOC_EDIT_ACTION = {
  accept: 'doc.edit.accept', decline: 'doc.edit.decline', undo: 'artifact.revisions.restore',
} as const satisfies Record<DocEditOperationKind, string>;

/** The Action's typed refusal when the Doc is no longer at the revision the person reviewed. */
const VERSION_MISMATCH = 'version_mismatch';

const sameRevision = (left: Revision, right: Revision) =>
  left.headerVersion === right.headerVersion &&
  left.bodyVersion === right.bodyVersion;

function freshestRevision(admitted: Revision | null, stored: Revision | null): Revision | null {
  if (!admitted) return stored;
  if (!stored) return admitted;
  // Both facts are scoped to this Doc. Either monotonic component advancing means the retained
  // admitted read is older than the store fact that woke this card while its refresh is pending.
  return stored.headerVersion > admitted.headerVersion || stored.bodyVersion > admitted.bodyVersion
    ? stored
    : admitted;
}

function revisionCurrency(current: Revision | null, basis: Revision): Currency {
  if (!current) return 'unknown';
  if (sameRevision(current, basis)) return 'current';
  return current.headerVersion > basis.headerVersion || current.bodyVersion > basis.bodyVersion
    ? 'movedOn'
    : 'unknown';
}

function readRevisionKey(key: string): Revision | null {
  if (key === '') return null;
  const separator = key.indexOf(':');
  if (separator === -1) return null;
  return {
    headerVersion: Number(key.slice(0, separator)),
    bodyVersion: Number(key.slice(separator + 1)),
  };
}

/** The approval observer is demand-mounted: settled and ordinary open cards carry no continuation stack. */
function DocEditApprovalContinuation(props: Readonly<{
  client: ArtifactActionsClient;
  operationKey: string;
  heldKind: DocEditOperationKind;
  heldApprovalId: string;
  settleDecision: (decided: DocEditProposalDispositionV1) => void;
  refuseDecision: (failure: string | ArtifactActionFailure) => void;
  settleUndo: (outcome: UndoOutcome) => void;
}>): null {
  const settlement = React.useRef({
    settleDecision: props.settleDecision,
    refuseDecision: props.refuseDecision,
    settleUndo: props.settleUndo,
  });
  settlement.current = {
    settleDecision: props.settleDecision,
    refuseDecision: props.refuseDecision,
    settleUndo: props.settleUndo,
  };
  const { requestApproval } = useActionApprovalContinuation({
    scopeKey: `${props.client.scope.serverId}:${props.client.scope.accountId}`,
    serverId: props.client.scope.serverId,
    onExecuted: () => {},
  });
  React.useEffect(() => {
    const release = () => {
      if (readDocEditOperation(props.operationKey)?.approvalId === props.heldApprovalId) {
        releaseDocEditOperation(props.operationKey);
      }
    };
    requestApproval(createActionApprovalContinuation({
      artifactId: props.heldApprovalId,
      scope: props.client.scope,
      actionId: DOC_EDIT_ACTION[props.heldKind],
      onSucceeded: (value: unknown) => {
        if (props.heldKind === 'undo') {
          settlement.current.settleUndo({ state: 'done', revision: (value as { revision: Revision }).revision });
        } else {
          release();
          settlement.current.settleDecision(
            (value as { docEditProposalDispositionV1: DocEditProposalDispositionV1 }).docEditProposalDispositionV1,
          );
        }
      },
      onFailed: (code, failure) => {
        release();
        const reason = readArtifactActionFailure(failure ?? { errorCode: code });
        // A refused or canceled request changes nothing: the card shows what it showed before it.
        if (code === 'approval_rejected' || code === 'approval_canceled') return;
        if (props.heldKind === 'undo') {
          settlement.current.settleUndo(reason.code === VERSION_MISMATCH ? { state: 'conflict' } : { state: 'failed', failure: reason });
        } else {
          settlement.current.refuseDecision(reason);
        }
      },
    }));
  }, [props.client.scope, props.heldApprovalId, props.heldKind, props.operationKey, requestApproval]);
  return null;
}

/**
 * A suggested edit in its passage thread (C5 L8 / lab K1): the reviewed before/after through the one
 * prose diff owner, why it was suggested, the revision it is based on, and Accept / Decline for the
 * person reading it. The stored disposition (C3) is the authority for accepted/declined; a decision
 * shows as settled only once the Home acknowledges it, and a stale basis says nothing was applied.
 */
type ArtifactEditProposalProps = Readonly<{
    testID?: string;
    client: ArtifactActionsClient;
    /** Present on a Doc view even while loading/unavailable; absent only for a standalone thread. */
    docRead?: AdmittedDocRead;
    /** The committed proposal message; `null` while the post is still local. */
    proposalRef: DiscussionMessageRefV1 | null;
    proposal: DocEditProposalV1;
    selectedPassage?: DocPassageRefV1;
    disposition: DocEditProposalDispositionV1 | undefined;
    viewerAccountId: string | null;
    resolveAccountLabel: (accountId: string) => string | null;
    /** Who suggested the edit, as the thread names and mentions them; Ask to redo addresses them. */
    proposer?: ProposalAuthor | null;
    /**
     * The card names its proposer in its title. A Doc margin thread shows the suggestion without its
     * message's byline; a Discussion message already names its speaker above the card.
     */
    namesProposer?: boolean;
    /** The Doc's body paints this suggestion in place (lab K1-A): while it is current the card leaves the diff to it. */
    diffInBody?: boolean;
    /** A later suggestion in its thread replaced this one: it no longer asks its author to redo it. */
    superseded?: boolean;
  }>;

export function ArtifactEditProposal(props: ArtifactEditProposalProps): React.ReactElement {
  // A passage thread reuses this slot for its newest suggestion. Its local acknowledgement,
  // refusal and Undo belong to one proposal, while echoes of that same proposal keep them.
  const key = props.proposalRef ? docEditOperationKey(props.client.scope, props.proposalRef.messageId) : null;
  return <ArtifactEditProposalCard key={key} {...props} />;
}

function ArtifactEditProposalCard(props: ArtifactEditProposalProps): React.ReactElement {
  const { theme } = useUnistyles();
  const router = useRouter();
  const styles = stylesheet;
  const testID = props.testID ?? 'artifact-edit-proposal';
  const { client, proposal, proposalRef } = props;
  const artifactId = proposal.target.ref.artifactId;
  const base = proposal.baseRevision;

  // The Home's acknowledgement stands in until the thread's own disposition catches up with it.
  const [acknowledged, setAcknowledged] =
    React.useState<DocEditProposalDispositionV1 | null>(null);
  const disposition =
    props.disposition && props.disposition.state !== 'open'
      ? props.disposition
      : (acknowledged ?? props.disposition ?? { state: 'open' as const });
  // The Doc's revision as the app already holds it (kept current by sync, as the Doc page reads it): when
  // another edit lands, this suggestion's currency is read again rather than left as it was on mount.
  const storedRevisionKey = getStorage()((state) => {
    if (!areServerAccountScopesEqual(state.profileScope, client.scope)) return '';
    const stored = state.artifacts[artifactId];
    return stored?.bodyVersion === undefined ? '' : `${stored.headerVersion}:${stored.bodyVersion}`;
  });
  const storedRevision = readRevisionKey(storedRevisionKey);
  const [standaloneRead, setStandaloneRead] = React.useState<Readonly<{
    client: ArtifactActionsClient; artifactId: string; read: AdmittedDocRead;
  }> | null>(null);
  const docRead = props.docRead ?? (standaloneRead?.client === client && standaloneRead.artifactId === artifactId
    ? standaloneRead.read : undefined);
  const admitted = docRead?.status === 'ready'
    && docRead.value.ref.artifactId === artifactId
    && areServerProfileIdentifiersEquivalent(docRead.value.ref.serverId, client.scope.serverId)
      ? docRead.value.artifact : null;
  const currentRevision = freshestRevision(admitted?.revision ?? null, storedRevision);
  const [refusal, setRefusal] = React.useState<
    'movedOn' | 'cantEdit' | ArtifactActionFailure | null
  >(null);
  const [busy, setBusy] = React.useState<Busy>(null);
  const currency: Currency = refusal === 'movedOn' ? 'movedOn'
    : admitted ? revisionCurrency(currentRevision, base) : 'unknown';
  const [undoFailure, setUndoFailure] = React.useState<Exclude<UndoOutcome, { state: 'done' }> | null>(null);
  // One admission for this proposal's Accept, Decline and Undo, across this card, its compact notice and a
  // remounted card (Back); a gated Action stays held until its approval settles.
  const operationKey = proposalRef ? docEditOperationKey(client.scope, proposalRef.messageId) : null;
  const operation = useDocEditOperation(operationKey);
  const approvalOperation = operation?.approvalId ? operation : null;
  const restoredBodyVersion = useDocEditRestoredVersion(client, artifactId, base.bodyVersion,
    disposition.state === 'accepted' && !(operation && 'restoredRevision' in operation)
      ? disposition.acceptedRevision.bodyVersion : null, admitted);

  const undo: UndoOutcome | null = operation && 'restoredRevision' in operation
    ? { state: 'done', revision: operation.restoredRevision } : undoFailure;
  const settleUndo = React.useCallback((outcome: UndoOutcome) => {
    if (outcome.state === 'done' && operationKey) settleDocEditUndo(operationKey, outcome.revision);
    else if (outcome.state !== 'done') setUndoFailure(outcome);
  }, [operationKey]);

  React.useEffect(() => {
    // A parent shares one read across visible Discussion cards. A standalone accepted receipt still
    // needs this same current-Doc fact before its restore can be offered; a declined receipt does not.
    if (props.docRead !== undefined || disposition.state === 'declined') return;
    let live = true;
    setStandaloneRead({ client, artifactId, read: { status: 'loading' } });
    // The Doc lives in this thread's Home (C5 §4), which the client is already bound to; its stored
    // label may be another device's name for that Home, so the read names only the document.
    void client.readDoc({ ref: { kind: 'doc', artifactId } }).then((read) => {
      if (!live) return;
      // A reader is told who can accept up front rather than after pressing Accept.
      if (read.ok && read.value.artifact.access === 'view') setRefusal('cantEdit');
      setStandaloneRead({ client, artifactId, read: read.ok
        ? { status: 'ready', value: read.value } : { status: 'unavailable' } });
    });
    return () => {
      live = false;
    };
  }, [client, artifactId, base, disposition.state, storedRevisionKey, props.docRead]);

  // A gated Action waits on a person's approval; the Inbox request is where that is decided.
  const openApproval = React.useCallback(
    (approvalId: string) => router.push(buildApprovalHref(approvalId, client.scope.serverId) as never),
    [client.scope.serverId, router],
  );

  /** The one place a decision's settled disposition lands, however the Action was admitted or approved. */
  const settleDecision = React.useCallback((decided: DocEditProposalDispositionV1) => {
    setAcknowledged(decided);
    // On a phone the receipt scrolls away with the thread; the app's one notice confirms the new
    // version and keeps Undo in reach (lab K1-Rp). Wider layouts show the receipt in place.
    if (decided.state === 'accepted' && readViewportClass() === 'compact' && operationKey)
      announceAccepted(client, artifactId, base.bodyVersion, decided.acceptedRevision, operationKey, openApproval);
  }, [artifactId, base.bodyVersion, client, openApproval, operationKey]);
  const refuseDecision = React.useCallback((failure: string | ArtifactActionFailure) => {
    const value = typeof failure === 'string' ? { code: failure } : failure;
    const code = value.code;
    if (code === VERSION_MISMATCH) setRefusal('movedOn');
    else setRefusal(code === 'doc_edit_proposal_edit_access_required' ? 'cantEdit' : value);
  }, []);

  const decide = React.useCallback(
    async (kind: 'accept' | 'decline') => {
      if (!proposalRef || !operationKey || busy || !admitDocEditOperation(operationKey, kind)) return;
      setBusy(kind);
      setRefusal(null);
      const outcome =
        kind === 'accept'
          ? await client.acceptEdit({ proposalRef, expectedRevision: base })
          : await client.declineEdit({ proposalRef });
      setBusy(null);
      if ('approvalId' in outcome) {
        holdDocEditApproval(operationKey, outcome.approvalId);
        openApproval(outcome.approvalId);
        return;
      }
      releaseDocEditOperation(operationKey);
      if (outcome.ok) settleDecision(outcome.value.docEditProposalDispositionV1);
      else refuseDecision(outcome.failure);
    },
    [base, busy, client, proposalRef, operationKey, openApproval, settleDecision, refuseDecision],
  );

  const undoAccepted = React.useCallback(async () => {
    if (disposition.state !== 'accepted' || busy || !operationKey || !admitDocEditOperation(operationKey, 'undo')) return;
    setBusy('undo');
    const outcome = await client.restoreRevision({
      artifactId,
      bodyVersion: base.bodyVersion,
      expectedRevision: disposition.acceptedRevision,
    });
    setBusy(null);
    // Waiting on approval is not an outcome: the operation stays held (no second request from this card,
    // its notice or a remounted card) and its approval's settlement decides what the receipt says next.
    if ('approvalId' in outcome) {
      holdDocEditApproval(operationKey, outcome.approvalId);
      return;
    }
    if (!outcome.ok) releaseDocEditOperation(operationKey);
    settleUndo(
      outcome.ok
        ? { state: 'done', revision: outcome.value.revision }
        : outcome.failure.code === VERSION_MISMATCH
          ? { state: 'conflict' }
          : { state: 'failed', failure: outcome.failure },
    );
  }, [artifactId, base.bodyVersion, busy, client, disposition, operationKey, settleUndo]);

  const docTitle = typeof admitted?.header.title === 'string' ? admitted.header.title : null;
  const readOnly = refusal === 'cantEdit' || admitted?.access === 'view';
  const refusalMessage = refusal && typeof refusal === 'object'
    ? resolveActionExecutionErrorMessage(refusal, t('artifacts.browser.proposal.failed')) : null;
  // History is the one place to pick a version. Compare opens it on the version the suggestion was
  // reviewed against, beside the current text; a refused Undo opens it as it is.
  const openHistory = React.useCallback((compareFromBodyVersion?: number) => showArtifactHistorySheet({
    artifactId, client, currentDoc: admitted ?? undefined,
    name: docTitle || undefined, canRestore: !readOnly,
    ...(compareFromBodyVersion === undefined ? {} : { compareFromBodyVersion }),
  }), [admitted, artifactId, client, docTitle, readOnly]);
  const compare = React.useCallback(() => openHistory(base.bodyVersion), [base.bodyVersion, openHistory]);
  const proposer = props.proposer ?? null;
  const proposedByViewer = proposer !== null && 'accountId' in proposer.mention && proposer.mention.accountId === props.viewerAccountId;
  const askable = proposalRef !== null && proposer !== null && !proposedByViewer && props.superseded !== true;
  // Ask to redo prepares an addressed reply in this thread; the person still reads and sends it.
  const askToRedo = React.useCallback(() => {
    if (!proposalRef || !proposer) return;
    const reference = 'accountId' in proposer.mention
      ? buildDiscussionAccountMentionPayload(proposer.mention.accountId, proposer.label)
      : { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, proposer.mention.sessionId), label: proposer.label };
    const mention = formatInlineReferenceTokenV1(reference);
    router.push(client.beginProposalReply({
      proposalRef,
      text: `${mention} ${t('artifacts.browser.proposal.redoRequest')}`,
      mentions: [{ ...reference, start: 0, end: mention.length, tokenText: mention }],
    }) as never);
  }, [client, proposalRef, proposer, router]);

  const decider = (accountId: string) =>
    accountId === props.viewerAccountId
      ? null
      : (props.resolveAccountLabel(accountId) ??
        t('artifacts.browser.proposal.someone'));

  const decision = ((): HappierDocEditProposalState => {
    if (disposition.state === 'accepted') {
      const who = decider(disposition.decidedBy.accountId);
      const n = disposition.acceptedRevision.bodyVersion;
      const lines: HappierDocEditProposalLine[] = [];
      const undoneVersion = restoredBodyVersion ?? (undo?.state === 'done' ? undo.revision.bodyVersion : null);
      if (undoneVersion !== null) lines.push({
        testID: `${testID}.undone`, mark: 'undone',
        text: t('artifacts.browser.proposal.undone', { n: undoneVersion }),
      });
      if (approvalOperation?.kind === 'undo') {
        const { approvalId } = approvalOperation;
        lines.push({
          testID: `${testID}.undoPending`, mark: 'warning', tone: 'warning', text: t('approvals.waitingForYou'),
          action: { label: t('approvals.review'), onPress: () => openApproval(approvalId!), testID: `${testID}.undoPending.open` },
        });
      }
      // Undo restores over the accepted revision only: a Doc that has moved on since says so from the first
      // mount, not after a refused press.
      const acceptedCurrency = revisionCurrency(currentRevision, disposition.acceptedRevision);
      const undoStale = restoredBodyVersion === null && (undo?.state === 'conflict' || (acceptedCurrency === 'movedOn' && undo === null));
      if (undoStale) lines.push({
        testID: `${testID}.undoConflict`, mark: 'reason', tone: 'neutral',
        text: t('artifacts.browser.proposal.undoConflict'),
        action: { label: t('artifacts.browser.proposal.openHistory'), onPress: () => openHistory(), testID: `${testID}.undoConflict.open` },
      });
      if (undo?.state === 'failed') lines.push({
        testID: `${testID}.undoFailed`, mark: 'failed', tone: 'danger', text: resolveActionExecutionErrorMessage(undo.failure, t('artifacts.browser.proposal.failed')),
      });
      return {
        state: 'settled',
        receipt: {
          testID: `${testID}.accepted`, mark: 'accepted',
          text: who ? t('artifacts.browser.proposal.acceptedBy', { who, n }) : t('artifacts.browser.proposal.acceptedByYou', { n }),
          // Undo is offered while it can still act: not after it ran or conflicted, and not while an operation
          // for this proposal (this card's, its notice's, or an approval it waits on) holds custody.
          action: (undo && undo.state !== 'failed') || acceptedCurrency !== 'current' || approvalOperation ? undefined : {
            label: t('artifacts.browser.proposal.undo'), busy: busy === 'undo', disabled: operation !== null && busy !== 'undo',
            onPress: () => void undoAccepted(), testID: `${testID}.undo`,
          },
        },
        lines,
      };
    }
    if (disposition.state === 'declined') {
      const who = decider(disposition.decidedBy.accountId);
      return {
        state: 'settled',
        receipt: {
          testID: `${testID}.declined`, mark: 'declined',
          text: who ? t('artifacts.browser.proposal.declinedBy', { who }) : t('artifacts.browser.proposal.declinedByYou'),
        },
      };
    }
    const locked = busy !== null || operation !== null;
    const decline = proposalRef ? {
      testID: `${testID}.decline`, label: t('artifacts.browser.proposal.decline'),
      disabled: locked, onPress: () => void decide('decline'),
    } : undefined;
    const open = {
      state: 'open' as const,
      // Your own suggestion has no one to name: "You suggests an edit" never reads.
      title: props.namesProposer && proposer && !proposedByViewer
        ? t('artifacts.browser.proposal.titleBy', { who: proposer.label })
        : t('artifacts.browser.proposal.title'),
      basedOn: t('artifacts.browser.proposal.basedOn', { n: base.bodyVersion }),
      note: docProposalChangesOutsideSelection(proposal, props.selectedPassage)
        ? t('artifacts.browser.proposal.outsideSelection') : undefined,
      reason: proposal.reason,
    };
    // A decision waiting on its approval is the whole story: one request, led to by Review.
    if (approvalOperation && approvalOperation.kind !== 'undo') {
      const { approvalId } = approvalOperation;
      return { ...open, basedOn: undefined, footer: { kind: 'note', line: {
        testID: `${testID}.decisionPending`, mark: 'warning', tone: 'warning', text: t('approvals.waitingForYou'),
        action: { label: t('approvals.review'), onPress: () => openApproval(approvalId!), testID: `${testID}.decisionPending.open` },
      } } };
    }
    if (currency === 'movedOn' || refusal === 'movedOn') {
      // Two ways forward (lab K1-ST): see what changed, or ask for a fresh suggestion. A suggestion
      // that can no longer apply can still be declined; that needs no Doc rewrite.
      return { ...open, footer: {
        kind: 'stale',
        line: {
          testID: `${testID}.movedOn`, mark: 'warning', tone: 'warning',
          text: refusalMessage ?? t('artifacts.browser.proposal.movedOn'),
        },
        compare: { testID: `${testID}.compare`, label: t('artifacts.browser.proposal.compare'), onPress: compare },
        decline: decline && !readOnly ? { ...decline, busy: busy === 'decline' } : undefined,
        askRedo: askable ? {
          testID: `${testID}.askRedo`, label: t('artifacts.browser.proposal.askRedo'),
          disabled: busy !== null, onPress: askToRedo,
        } : undefined,
      } };
    }
    if (readOnly) {
      return { ...open, footer: { kind: 'note', line: {
        testID: `${testID}.cantEdit`, mark: 'locked', text: t('artifacts.browser.proposal.cantEdit'),
      } } };
    }
    // A current suggestion states its version once, in the footer (lab L8-A).
    return { ...open, basedOn: currency === 'current' ? undefined : open.basedOn, footer: {
      kind: 'decide',
      status: busy === 'accept' || busy === 'decline'
        ? { indicator: 'busy', text: busy === 'accept' ? t('artifacts.browser.proposal.accepting') : t('artifacts.browser.proposal.declining') }
        : refusalMessage ? { text: refusalMessage }
          : currency === 'current'
            ? { indicator: 'current', testID: `${testID}.current`, text: t('artifacts.browser.proposal.current', { n: base.bodyVersion }) }
            : undefined,
      decline,
      // Unknown admission is not evidence that the reviewed Doc revision is still current.
      accept: proposalRef && currency === 'current' ? {
        testID: `${testID}.accept`, label: t('artifacts.browser.proposal.accept'),
        disabled: locked, busy: busy === 'accept', onPress: () => void decide('accept'),
      } : undefined,
    } };
  })();

  return (
    <>
      {operationKey && approvalOperation?.approvalId ? (
        <DocEditApprovalContinuation
          client={client}
          operationKey={operationKey}
          heldKind={approvalOperation.kind}
          heldApprovalId={approvalOperation.approvalId}
          settleDecision={settleDecision}
          refuseDecision={refuseDecision}
          settleUndo={settleUndo}
        />
      ) : null}
      <HappierDocEditProposal
        testID={testID}
        before={proposal.before}
        after={proposal.after}
        labels={{ before: t('artifacts.browser.proposal.before'), after: t('artifacts.browser.proposal.after') }}
        decision={decision}
        Text={ProposalText}
        Mark={ProposalMark}
        Button={ProposalButton}
        // The diff is printed once: in the body while the suggestion is current there, else on the card.
        Diff={props.diffInBody === true && disposition.state === 'open' && currency === 'current' ? NoProposalDiff : ProposalDiff}
        Spinner={ProposalSpinner}
        style={styles.card}
        space={theme.space}
      />
    </>
  );
}

export type ProposalAuthor = Readonly<{
  label: string;
  mention: Readonly<{ accountId: string }> | Readonly<{ sessionId: string }>;
}>;

/** Review the immutable suggestion before posting it; the approval owns Post / Deny. */
type ProposalReviewProps = Readonly<{ proposal: DocEditProposalV1 & Partial<Pick<DocEditProposeResolvedInputV1, 'discussionRef'>>; testID: string }>;

export function ArtifactEditProposalReview(props: ProposalReviewProps): React.ReactElement {
  return props.proposal.discussionRef
    ? <ConnectedProposalReview {...props} discussionRef={props.proposal.discussionRef} />
    : <ProposalReview {...props} />;
}

function ConnectedProposalReview(props: ProposalReviewProps & Readonly<{ discussionRef: DocEditProposeResolvedInputV1['discussionRef'] }>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.discussionRef.serverId);
  const availability = useSessionCollaborationAvailability(props.discussionRef.serverId);
  return binding && availability === 'available'
    ? <AdmittedProposalReview {...props} binding={binding} /> : <ProposalReview {...props} />;
}

function AdmittedProposalReview(props: ProposalReviewProps & Readonly<{
  discussionRef: DocEditProposeResolvedInputV1['discussionRef']; binding: ServerCredentialAccountScopeBinding;
}>) {
  const { binding } = props;
  const discussionId = props.discussionRef.discussionId;
  const repository = React.useMemo(() => getDiscussionRepository({
    scope: binding.scope, address: { serverId: binding.scope.serverId }, accountLifetime: binding,
    client: createDiscussionClient({ scope: binding.scope, availability: 'available' }),
  }), [binding]);
  const { thread } = useDiscussionComposerSnapshot(repository, discussionId);
  React.useEffect(() => {
    const controller = new AbortController();
    const release = repository.mount({ discussionId });
    void repository.refreshDiscussion(discussionId, controller.signal, { includeFirstMessage: true }).catch(() => {});
    return () => { controller.abort(); release(); };
  }, [discussionId, repository]);
  const selectedPassage = React.useMemo(() => readDocProposalSelection(thread?.messages ?? []), [thread?.messages]);
  return <ProposalReview {...props} selectedPassage={selectedPassage} />;
}

function ProposalReview(props: ProposalReviewProps & Readonly<{ selectedPassage?: DocPassageRefV1 }>): React.ReactElement {
  const { theme } = useUnistyles();
  return <HappierDocEditProposal
    testID={props.testID}
    before={props.proposal.before}
    after={props.proposal.after}
    labels={{ before: t('artifacts.browser.proposal.before'), after: t('artifacts.browser.proposal.after') }}
    decision={{ state: 'open', title: t('artifacts.browser.proposal.title'),
      basedOn: t('artifacts.browser.proposal.basedOn', { n: props.proposal.baseRevision.bodyVersion }),
      note: docProposalChangesOutsideSelection(props.proposal, props.selectedPassage)
        ? t('artifacts.browser.proposal.outsideSelection') : undefined,
      reason: props.proposal.reason, footer: { kind: 'decide' } }}
    Text={ProposalText} Mark={ProposalMark} Button={ProposalButton} Diff={ProposalDiff} Spinner={ProposalSpinner}
    space={theme.space}
  />;
}

const MARK: Readonly<Record<HappierDocEditProposalMark, IconName>> = {
  proposal: 'pencil-simple', reason: 'arrow-elbow-down-right', current: 'check', accepted: 'check', declined: 'x',
  undone: 'clock-counter-clockwise', warning: 'warning', failed: 'warning-circle', locked: 'lock',
};

function toneColor(theme: ReturnType<typeof useUnistyles>['theme'], tone: HappierDocEditProposalTone | undefined): string {
  return tone === 'warning' ? theme.colors.state.warning.foreground
    : tone === 'danger' ? theme.colors.text.destructive
      : tone === 'muted' ? theme.colors.text.tertiary : theme.colors.text.secondary;
}

function ProposalMark(props: HappierDocEditProposalMarkProps) {
  const { theme } = useUnistyles();
  return <Icon name={MARK[props.mark]} size={ICON_SIZE.sm} color={toneColor(theme, props.tone)} />;
}

function ProposalText(props: HappierDocEditProposalTextProps) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  if (props.role === 'title') {
    return <Text variant="label" emphasis="semiBold" style={styles.title}>{props.children}</Text>;
  }
  if (props.role === 'meta') {
    return <Text testID={props.testID} variant="meta" style={styles.meta} numberOfLines={props.numberOfLines}>{props.children}</Text>;
  }
  if (props.role === 'reason') return <Text variant="body" style={styles.reasonText}>{props.children}</Text>;
  // A receipt reads in primary ink; a status line takes its tone's colour.
  const color = props.role === 'receipt' ? theme.colors.text.primary : toneColor(theme, props.tone);
  return (
    <Text variant="meta" emphasis={props.role === 'receipt' ? 'medium' : undefined} style={[styles.lineText, { color }]}>
      {props.children}
    </Text>
  );
}

function ProposalButton(props: HappierDocEditProposalButtonProps) {
  const { theme } = useUnistyles();
  return (
    <RoundButton
      testID={props.testID}
      size="small"
      display={props.emphasis === 'primary' ? undefined : 'inverted'}
      title={props.label}
      textStyle={props.emphasis === 'secondary' ? { color: theme.colors.text.secondary } : undefined}
      loading={props.busy}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}

function ProposalDiff(props: HappierDocEditProposalDiffProps) {
  return (
    <ProseDiffViewer
      mode="text"
      testID={props.testID}
      oldText={props.before}
      newText={props.after}
      prose={{ oldLabel: props.beforeLabel, newLabel: props.afterLabel, words: true }}
    />
  );
}

function NoProposalDiff(): null {
  return null;
}

function ProposalSpinner() {
  return <ActivitySpinner size="small" />;
}

const stylesheet = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.space.s8,
    padding: theme.space.s12,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
    ...resolveThemeHairlineBorderStyle(theme.colors.border.subtle),
  },
  title: { color: theme.colors.text.primary },
  meta: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  reasonText: { color: theme.colors.text.secondary },
  // The receipt text wraps inside itself, so its action stays at the end of the line even in a
  // narrow Doc margin (lab K1-R).
  lineText: { minWidth: 0 },
}));

const ACCEPTED_NOTICE_KEY = 'artifacts.proposal.accepted';

/** The accepted-edit notice; its Undo restores the base version unless the Doc moved on since. */
export function announceAccepted(
  client: ArtifactActionsClient, artifactId: string, baseBodyVersion: number, accepted: Revision,
  operationKey: string, openApproval: (approvalId: string) => void,
): void {
  publishPresentationNotice({
    key: ACCEPTED_NOTICE_KEY,
    severity: 'info',
    message: t('artifacts.browser.passage.acceptedToast', { n: accepted.bodyVersion }),
    undo: {
      label: t('artifacts.browser.proposal.undo'),
      run: () => {
        // The card's own Undo and this one are one operation: whichever is admitted first holds custody, and
        // while that request waits on its approval this entry leads to it instead of creating another.
        if (!admitDocEditOperation(operationKey, 'undo')) {
          const waiting = readDocEditOperation(operationKey)?.approvalId;
          if (waiting) openApproval(waiting);
          return;
        }
        void client.restoreRevision({ artifactId, bodyVersion: baseBodyVersion, expectedRevision: accepted }).then((outcome) => {
          if ('approvalId' in outcome) {
            holdDocEditApproval(operationKey, outcome.approvalId);
            openApproval(outcome.approvalId);
            return;
          }
          if (outcome.ok) settleDocEditUndo(operationKey, outcome.value.revision);
          else releaseDocEditOperation(operationKey);
          publishPresentationNotice(outcome.ok
            ? { key: ACCEPTED_NOTICE_KEY, severity: 'info', message: t('artifacts.browser.proposal.undone', { n: outcome.value.revision.bodyVersion }) }
            : { key: ACCEPTED_NOTICE_KEY, severity: 'warning', message: outcome.failure.code === VERSION_MISMATCH
              ? t('artifacts.browser.proposal.undoConflict') : resolveActionExecutionErrorMessage(outcome.failure, t('artifacts.browser.proposal.failed')) });
        });
      },
    },
  });
}
