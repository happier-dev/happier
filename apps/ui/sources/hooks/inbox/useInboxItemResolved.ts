import * as React from 'react';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { classifyInboxSessionCandidate } from '@/activity/presentation/buildInboxSessionPresentation';
import { type InboxItemFocus, readInboxApprovalServerId } from '@/components/inbox/inboxItemFocus';
import { inboxItemView } from '@/components/inbox/inboxItems';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { isOpenAccountNotice } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { readRegisteredDiscussionRepository, subscribeRegisteredDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { InboxModel } from './useInboxModel';

/** Selection consumes the existing owners' positive answer facts, never absence from a list. */
export function useInboxItemResolved(
    focus: InboxItemFocus | null,
    model: Pick<InboxModel, 'sessionCandidates' | 'accountNotices'> & Readonly<{
        isDataReady: boolean;
        sessionScopes?: InboxModel['source']['audienceScopes'];
    }>,
): boolean {
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope ?? null;
    const sameHome = Boolean(focus && scope && (!focus.serverId && focus.kind === 'approval'
        || areServerProfileIdentifiersEquivalent(focus.serverId, scope.serverId)));
    // Activity already binds multi-Home Session candidates to their exact credentials.
    // Other Inbox producers use the active Account store; do not rebind those records.
    const sessionScope = focus?.kind === 'session' ? model.sessionScopes?.get(focus.serverId) : null;
    const readableHome = sameHome || Boolean(focus?.kind === 'session' && sessionScope
        && areServerProfileIdentifiersEquivalent(sessionScope.serverId, focus.serverId));
    const kind = focus?.kind;
    const id = focus?.id;
    const messageId = focus?.kind === 'discussion' ? focus.messageId : null;
    // Reuse the canonical store's exact record, independently of list membership. No
    // selected entity means no detail subscription; unrelated records retain this snapshot.
    const readRecord = React.useCallback(() => {
        if (!lifetime?.isCurrent() || !readableHome || !id) return null;
        if (kind === 'approval') return storage.getState().artifacts[id] ?? null;
        if (kind === 'workflow_run') return storage.getState().workflowRunsById[workflowRunStoreKey(id, lifetime.scope)] ?? null;
        if (kind === 'discussion') {
            const snapshot = readRegisteredDiscussionRepository(lifetime.scope, { serverId: lifetime.scope.serverId })?.getSnapshot();
            const attention = snapshot?.attention.discussions.find(entry => entry.discussion.id === id)
                ?.occurrences.find(entry => entry.message.id === messageId)?.message;
            const thread = snapshot?.threads[id]?.messages.find(message => message.id === messageId);
            // The repository's mergeDiscussionMessages contract makes dispositions final:
            // an older open response cannot reopen an accepted or declined proposal.
            return attention?.docEditProposalDispositionV1 && attention.docEditProposalDispositionV1.state !== 'open'
                ? attention : thread ?? attention ?? null;
        }
        return true as const;
    }, [id, kind, lifetime, messageId, readableHome]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!lifetime || !sameHome || !id) return () => {};
        const unsubscribe = kind === 'discussion'
            ? subscribeRegisteredDiscussionRepository(lifetime.scope, { serverId: lifetime.scope.serverId }, notify)
            : kind === 'approval' ? storage.subscribe(notify, { artifacts: [id] })
                : kind === 'workflow_run' ? storage.subscribe(notify,
                    { workflowRunsById: [workflowRunStoreKey(id, lifetime.scope)] }) : null;
        return () => { unsubscribe?.(); };
    }, [id, kind, lifetime, sameHome]);
    const record = React.useSyncExternalStore(subscribe, readRecord, readRecord);
    if (!focus || !scope || record === null || !model.isDataReady) return false;

    switch (focus.kind) {
        case 'approval': {
            const artifact = record !== true && 'isDecrypted' in record ? record : null;
            if (!artifact?.isDecrypted || artifact.draft === true) return false;
            const home = readInboxApprovalServerId(artifact.header);
            if (home && !areServerProfileIdentifiersEquivalent(home, scope.serverId)) return false;
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, typeof artifact.body === 'string' ? artifact.body : null);
            return parsed !== null && parsed.request.status !== 'open';
        }
        case 'notice': {
            const entry = model.accountNotices.find(entry => entry.artifact.id === focus.id);
            return entry !== undefined && !isOpenAccountNotice(entry.header);
        }
        case 'session': {
            const candidate = model.sessionCandidates.find(candidate => candidate.sessionId === focus.id
                && areServerProfileIdentifiersEquivalent(candidate.address?.serverId ?? candidate.serverId ?? '', focus.serverId));
            const type = candidate ? classifyInboxSessionCandidate(candidate).type : null;
            return candidate !== undefined && isSessionAwarenessContentReadableV1(candidate.awareness.encryption)
                && (type === null || inboxItemView(type) !== 'needs_you');
        }
        case 'workflow_run': {
            const run = record !== true && 'summary' in record ? record : null;
            if (!run?.summary) return false;
            const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run.summary) });
            return status.bucket !== 'needs_you' || status.attentionType === null || inboxItemView(status.attentionType) !== 'needs_you';
        }
        case 'execution_run':
            // An absent running-roster row is not positive evidence of a resolved permission.
            return false;
        case 'automation_run':
            // Automation rows are Updates at their canonical Inbox projection.
            return false;
        case 'managed_machine':
            // Withdrawing a deadline is not a recorded answer to the selected Machine.
            return false;
        case 'discussion':
            return record !== true && 'messageRef' in record && record.docEditProposalDispositionV1 != null
                && record.docEditProposalDispositionV1.state !== 'open';
    }
}
