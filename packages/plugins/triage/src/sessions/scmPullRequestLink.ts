import { PluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { ProtocolActionApprovalRequestCreatedResultSchema, ScmPullRequestSummaryProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import type { ScmPullRequestSummary } from '@happier-dev/plugin-sdk/scm';
import { ActionSessionAddressV1Schema, type ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SessionPullRequestBindingInputV1Schema,
    SessionPullRequestBindingResultV1Schema, type SessionPullRequestBindingResultV1,
} from '@happier-dev/channels-protocol/v1';

export type TriageSnapshotPullRequestLinkHostV1 = Pick<PluginUiHostApi, 'selectActionInput' | 'executeAction'>;
type AttachmentResult = Extract<SessionPullRequestBindingResultV1, { kind: 'attached' }>
    | ReturnType<typeof ProtocolActionApprovalRequestCreatedResultSchema.parse>;
export type TriageSnapshotPullRequestLinkResultV1 = AttachmentResult
    | Readonly<{ kind: 'cancelled' }>;
type LinkInput = Readonly<{
    /** Canonical Home stamped by this mount's Account owner, never a user-supplied target. */
    homeServerId: string;
    pullRequest: ScmPullRequestSummary;
    session: ActionSessionAddressV1;
}>;

/** Existing binding admission proves accepted-checkout correspondence; this caller never creates a PR. */
export async function linkTriageSnapshotPullRequestV1(
    host: TriageSnapshotPullRequestLinkHostV1,
    input: LinkInput,
    options?: PluginCancellationOptions,
): Promise<AttachmentResult> {
    throwIfAborted(options?.signal);
    const session = ActionSessionAddressV1Schema.parse(input.session);
    if (session.serverId !== input.homeServerId) {
        throw new PluginError({ code: 'denied', message: 'The selected Session is not in this mounted Home.' });
    }
    const pullRequest = ScmPullRequestSummaryProtocolSchema.parse(input.pullRequest);
    // The picker and Action inherit the same admitted Home. There is no qualified
    // Session string grammar: check the exact address before passing its local id.
    const operand = SessionPullRequestBindingInputV1Schema.parse({ kind: 'attach', sessionId: session.sessionId,
        pullRequestUrl: pullRequest.url });
    const response = await host.executeAction({
        pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
    }, operand, options);
    const approval = ProtocolActionApprovalRequestCreatedResultSchema.safeParse(response);
    if (approval.success) return approval.data;
    const result = SessionPullRequestBindingResultV1Schema.parse(response);
    if (result.kind !== 'attached') throw new PluginError({ code: 'invalid_request', message: 'The link Action did not return an attachment.' });
    return result;
}

/** Project-only discovery asks the incumbent readable-Session picker, without demanding Session status. */
export async function chooseAndLinkTriageSnapshotPullRequestV1(
    host: TriageSnapshotPullRequestLinkHostV1,
    input: Omit<LinkInput, 'session'>,
    options?: PluginCancellationOptions,
): Promise<TriageSnapshotPullRequestLinkResultV1> {
    throwIfAborted(options?.signal);
    const choice = await host.selectActionInput({ hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } }, options);
    if (choice.kind === 'cancelled') return choice;
    if (choice.kind !== 'sessionAddress') throw new PluginError({ code: 'invalid_request', message: 'An exact Session selection is required.' });
    return linkTriageSnapshotPullRequestV1(host, { ...input, session: choice.session }, options);
}
