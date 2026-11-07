import { computeCanonicalDomainSeparatedDigest, isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { renderSessionInputContextPromptV1, SessionAcceptedWorkspaceV1Schema, SessionMessageSendResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { type SessionPullRequestConfiguredFixInputV1,
    type SessionPullRequestConfiguredFixResultV1 } from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_RECORD_KIND, SessionPullRequestConfiguredFixCustodySchema } from './collections.js';
import { isConfiguredFixResultUncertain, persistConfiguredFixResultV19, restoreConfiguredFixResultV19 } from './configuredFixResultV19.js';
import { readConversationBindingUpdateRow, readConversationConnectionUpdateRow } from './accountLocalBindingPolicy.js';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { readSessionPullRequestWatchPolicy } from './sessionPullRequestWatchPolicy.js';
import { admitSessionPullRequestFixRound, reconcileSessionPullRequestFixProgress } from './sessionPullRequestWatchProgress.js';
import { readSessionPullRequestWatchDefaults, type SessionPullRequestWatchContext } from './sessionPullRequestWatch.js';
import { readCurrentSessionPullRequestWatchHead } from './sessionPullRequestWatchRound.js';

function refuse(code: string): never {
    throw new PluginError({ code, message: 'The configured PR Fix no longer matches its current watch, pull request or head.' });
}

/** Choice, source preparation, linking and UI recovery remain the caller's responsibility. */
export async function deliverSessionPullRequestConfiguredFix(input: SessionPullRequestConfiguredFixInputV1 & { sessionId: string },
    context: SessionPullRequestWatchContext): Promise<SessionPullRequestConfiguredFixResultV1> {
    const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
    const obligationId = computeCanonicalDomainSeparatedDigest('happier:channels:configured-fix:v1',
        [input.bindingId, input.sessionId, input.delivery.idempotencyKey]);
    const readBinding = async () => {
        const row = await collection.get(input.bindingId, { signal: context.signal });
        if (!row) return refuse('channels_pr_watch_binding_unavailable');
        const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
        if (binding.deletionState !== 'none' || binding.target.kind !== 'session' || binding.target.sessionId !== input.sessionId
            || binding.target.pullRequestLink?.repository !== input.pullRequest.repository
            || binding.target.pullRequestLink?.number !== input.pullRequest.number || binding.endpoint.kind !== 'githubPullRequest') {
            return refuse('channels_pr_watch_scope_mismatch');
        }
        return { row, binding };
    };
    let current = await readBinding();
    let original = await collection.get(obligationId, { signal: context.signal });
    let retained = original ? SessionPullRequestConfiguredFixCustodySchema.parse(original.value.payload) : undefined;
    if (retained && !pluginJsonValuesEqual(retained.request, { ...input, expectedRevision: retained.request.expectedRevision })) {
        return refuse('channels_pr_watch_delivery_conflict');
    }
    // Reading an already delivered request reconciles its original host input,
    // even after Stop or terminal PR settlement. It never admits another round.
    const retainedResult = retained?.result && restoreConfiguredFixResultV19(retained.result);
    if (retainedResult && !isConfiguredFixResultUncertain(retainedResult)) {
        await reconcileSessionPullRequestFixProgress(input.bindingId, context);
        return { kind: 'configuredFixResult', result: retainedResult };
    }
    const policy = readSessionPullRequestWatchPolicy(current.binding);
    if (!current.binding.enabled || (policy.mode !== 'address' && policy.mode !== 'autoFix')
        || current.binding.endpoint.kind === 'githubPullRequest'
            && (current.binding.endpoint.pullRequestState?.state === 'closed' || current.binding.endpoint.pullRequestState?.state === 'merged')) {
        return refuse('channels_pr_watch_not_fixing');
    }
    if (!original && current.row.revision !== input.expectedRevision) return refuse('channels_pr_watch_conflict');
    const { fixAttemptLimit } = await readSessionPullRequestWatchDefaults(context);
    const ready = await admitSessionPullRequestFixRound({ bindingId: input.bindingId, obligationId,
        update: input, fixAttemptLimit, reserve: false }, context);
    if (ready !== 'ready') return { kind: 'configuredFixHeld', reason: ready };

    // Use the existing exact-PR SCM reader. The selected source has prepared
    // the checkout already; this arm does not pull, select or create one.
    const status = await context.services.actions.execute('session.status.get', {
        sessionId: input.sessionId, includeAcceptedWorkspace: true,
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(status)) return { kind: 'configuredFixUncertain' };
    const workspace = SessionAcceptedWorkspaceV1Schema.safeParse('acceptedWorkspace' in status ? status.acceptedWorkspace : undefined);
    if (!('session' in status) || status.session.id !== input.sessionId || !workspace.success) return refuse('channels_pr_watch_session_unavailable');
    const connectionRow = await collection.get(current.binding.connectionId, { signal: context.signal });
    if (!connectionRow) return refuse('channels_pr_watch_binding_unavailable');
    const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: current.binding.connectionId });
    const contribution = await readCurrentProviderContributionForPersistedSelection({
        context: { targetedContributions: context.services.targetedContributions, signal: context.signal },
        providerPluginId: connection.providerPluginId, providerContributionSelection: connection.providerContributionSelection,
    });
    const provider = contribution.descriptor.pullRequests;
    if (!provider) return refuse('channels_pr_watch_pr_unavailable');
    const observed = await readCurrentSessionPullRequestWatchHead({ update: input, cwd: workspace.data.checkout.rootPath, provider }, context);
    if (observed.kind === 'held') {
        if (observed.reason === 'approval') return { kind: 'configuredFixUncertain' };
        return refuse(observed.reason === 'scope' ? 'channels_pr_watch_pr_unavailable' : 'channels_pr_watch_stale_head');
    }
    if (observed.head.sha !== input.expectedHeadSha) {
        return refuse('channels_pr_watch_stale_head');
    }
    const before = current.row.revision;
    current = await readBinding();
    if (current.row.revision !== before) return refuse('channels_pr_watch_conflict');
    if (!original) {
        const now = context.invokedAtMs;
        const admission = await admitSessionPullRequestFixRound({ bindingId: input.bindingId, obligationId,
            update: input, fixAttemptLimit, expectedRevision: current.row.revision, newObligation: {
                id: obligationId, 'record-kind': CHANNEL_STATE_RECORD_KIND.ingressObligation, v: 1,
                'connection-id': current.binding.connectionId, 'binding-id': input.bindingId, 'session-id': input.sessionId,
                terminal: false, attention: false, 'created-at': now, 'updated-at': now,
                payload: { kind: 'configuredFix', request: input },
            } }, context);
        if (admission !== 'ready') return { kind: 'configuredFixHeld', reason: admission };
        original = await collection.get(obligationId, { signal: context.signal });
        if (!original) return refuse('channels_pr_round_input_unavailable');
        retained = SessionPullRequestConfiguredFixCustodySchema.parse(original.value.payload);
    }
    // Unknown delivery retries rejoin the host's original idempotent input.
    // A successful response is retained before host-start reconciliation.
    if (!original || !retained) return refuse('channels_pr_round_input_unavailable');
    const result = await context.services.actions.execute('session.message.send', {
        sessionId: input.sessionId, message: renderSessionInputContextPromptV1({ transformedUserText: input.delivery.text,
            ...(input.delivery.forgeEvidence ? { forgeEvidence: input.delivery.forgeEvidence } : {}) }),
        idempotencyKey: `channels:configured-fix:v1:${obligationId}`,
        ...(input.delivery.attachments ? { attachments: input.delivery.attachments } : {}),
        ...(input.delivery.forgeEvidence ? { forgeEvidence: input.delivery.forgeEvidence } : {}),
    }, { signal: context.signal }).catch(error => {
        if (isPluginError(error)) throw error;
        return undefined;
    });
    if (result === undefined || isPluginActionApprovalRequestCreated(result)) return { kind: 'configuredFixUncertain' };
    const accepted = SessionMessageSendResultV1ProtocolSchema.parse(result);
    await collection.put({ ...original.value,
        terminal: !isConfiguredFixResultUncertain(accepted), 'updated-at': context.invokedAtMs,
        payload: { kind: 'configuredFix', request: retained.request, result: persistConfiguredFixResultV19(accepted) },
    }, { expectedRevision: original.revision, signal: context.signal });
    await reconcileSessionPullRequestFixProgress(input.bindingId, context);
    return { kind: 'configuredFixResult', result: accepted };
}
