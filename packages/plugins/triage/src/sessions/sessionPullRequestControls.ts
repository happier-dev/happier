import type { JsonValue, PluginCancellationOptions, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { ProtocolActionApprovalRequestCreatedResultSchema } from '@happier-dev/plugin-sdk/protocol';
import { sameScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { SessionAcceptedWorkspaceV1Schema, type ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1, SESSION_PULL_REQUEST_WATCH_SETTINGS,
    SessionPullRequestWatchPolicyV1Schema, SessionPullRequestFixAttemptLimitV1Schema,
    SessionPullRequestWatchInputV1Schema, SessionPullRequestWatchResultV1Schema,
    type SessionPullRequestWatchPolicyV1, type SessionPullRequestWatchReadResultV1, type SessionPullRequestWatchResultV1,
} from '@happier-dev/channels-protocol/v1';
import type { TriageSessionPullRequestBindingV1 } from './sessionPullRequestStatus.js';

export type TriagePullRequestOperationHostV1 = Readonly<{
    executeAction(action: PluginContributionRef, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown>;
}>;
export type TriagePullRequestOperationSelectionV1 = Readonly<{
    binding: TriageSessionPullRequestBindingV1;
    operationId: string;
    variantId?: string;
}>;

/** A source offer is display data, not a grant. The original host/native Action admits every effect. */
export async function executeTriageSessionPullRequestOperationV1(
    host: TriagePullRequestOperationHostV1,
    selection: TriagePullRequestOperationSelectionV1,
    options?: PluginCancellationOptions,
): Promise<unknown> {
    throwIfAborted(options?.signal);
    const shown = selection.binding;
    const unavailable = { kind: 'unavailable', reason: 'operationUnavailable' } as const;
    if (shown.nativeStatus.kind !== 'current' || !shown.entry) return unavailable;
    const operations = shown.nativeStatus.value.operations;
    if (!operations) return unavailable;
    const offers = [operations.primary, ...operations.alternatives].filter(offer => offer.id === selection.operationId);
    const offer = offers[0];
    if (offers.length !== 1 || !offer || offer.disabledReason !== null) return unavailable;
    const choices = selection.variantId === undefined
        ? offer.variants.filter(variant => offer.variants.length === 1 && variant.method === undefined)
        : offer.variants.filter(variant => variant.id === selection.variantId);
    const variant = choices[0];
    if (choices.length !== 1 || !variant) return unavailable;
    // No native/status read, fallback method, approval reinterpretation or uncertain replay.
    return host.executeAction(offer.actionRef, variant.input, options);
}

type Binding = Extract<SessionPullRequestWatchReadResultV1, { kind: 'ready' }>['bindings'][number];
export type TriagePullRequestWatchDefaultsResultV1 = Readonly<{
    kind: 'ready'; policy: SessionPullRequestWatchPolicyV1; fixAttemptLimit: number | null;
}> | Readonly<{ kind: 'unavailable' }> | ActionApprovalRequestCreatedResult;
export async function readTriageSessionPullRequestWatchDefaultsV1(
    host: Pick<PluginUiHostApi, 'executeAction'>,
    options?: PluginCancellationOptions,
): Promise<TriagePullRequestWatchDefaultsResultV1> {
    throwIfAborted(options?.signal);
    try {
        const response = await host.executeAction('plugins.settings.list', {
            pluginId: 'happier.channels', scope: { kind: 'account' }, target: { kind: 'account' },
        }, options);
        throwIfAborted(options?.signal);
        const approval = ProtocolActionApprovalRequestCreatedResultSchema.safeParse(response);
        if (approval.success) return approval.data;
        // The host admits its Action result; this consumer validates only the Watch domain values.
        if (!('ok' in response) || !response.ok || response.kind !== 'plugins.settings.list'
            || response.data.scope.kind !== 'account' || response.data.target.kind !== 'account') return { kind: 'unavailable' };
        const fields = new Map(response.data.fields.flatMap(field => field.secret ? [] : [[field.localId, field.value] as const]));
        const policy = SessionPullRequestWatchPolicyV1Schema.safeParse({
            mode: fields.get(SESSION_PULL_REQUEST_WATCH_SETTINGS.defaultMode),
            archiveAfterMerge: fields.get(SESSION_PULL_REQUEST_WATCH_SETTINGS.archiveAfterMerge),
        });
        const limit = SessionPullRequestFixAttemptLimitV1Schema.safeParse(fields.get(SESSION_PULL_REQUEST_WATCH_SETTINGS.fixAttemptLimit));
        return policy.success && limit.success ? { kind: 'ready', policy: policy.data, fixAttemptLimit: limit.data } : { kind: 'unavailable' };
    } catch {
        throwIfAborted(options?.signal);
        return { kind: 'unavailable' };
    }
}
export type TriagePullRequestWatchAcceptanceResultV1 = SessionPullRequestWatchResultV1
    | ActionApprovalRequestCreatedResult
    | Readonly<{ kind: 'unavailable'; reason: 'sessionUnavailable' }>;
export type TriagePullRequestWatchOfferV1 = Readonly<{
    kind: 'offer'; session: ActionSessionAddressV1; bindingId: string; expectedRevision: number;
    policy: SessionPullRequestWatchPolicyV1;
}>;
type SessionState = NonNullable<Awaited<ReturnType<PluginUiHostApi['readSession']>>>;
export type TriagePullRequestControlHostV1 = Readonly<{
    readSession(sessionId: string, options?: PluginCancellationOptions): Promise<Pick<SessionState, 'sessionId' | 'serverId' | 'acceptedWorkspace'> | null>;
    executeAction(action: PluginContributionRef, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown>;
}>;
/** Only proven local workflow selectors belong here; hosted run/job identifiers never do. */
export type TriagePullRequestLocalCauseV1 = Readonly<{
    repository: ScmHostingRepositoryIdentityV1;
    workflowPath?: string;
    sourceHeadSha?: string;
}>;

/** Open/link success offers a choice; changing an Account default never changes a retained binding. */
export function projectTriagePullRequestWatchOfferV1(
    session: ActionSessionAddressV1,
    binding: Binding,
    defaultPolicy: SessionPullRequestWatchPolicyV1,
): TriagePullRequestWatchOfferV1 | null {
    if (defaultPolicy.mode === 'off' || binding.watch.policy.mode !== 'off'
        || binding.link.state === 'merged' || binding.link.state === 'closed') return null;
    return { kind: 'offer', session, bindingId: binding.bindingId, expectedRevision: binding.revision, policy: defaultPolicy };
}

/** The explicit Watch press uses the existing Action, preserving revision and confirmation policy. */
export async function acceptTriagePullRequestWatchOfferV1(
    host: Pick<TriagePullRequestControlHostV1, 'readSession'> & Pick<PluginUiHostApi, 'executeAction'>,
    offer: TriagePullRequestWatchOfferV1,
    options?: PluginCancellationOptions,
): Promise<TriagePullRequestWatchAcceptanceResultV1> {
    throwIfAborted(options?.signal);
    const state = await host.readSession(offer.session.sessionId, options);
    throwIfAborted(options?.signal);
    if (state === null || state.sessionId !== offer.session.sessionId || state.serverId !== offer.session.serverId)
        return { kind: 'unavailable' as const, reason: 'sessionUnavailable' as const };
    const input = SessionPullRequestWatchInputV1Schema.parse({ kind: 'configure', sessionId: offer.session.sessionId,
        bindingId: offer.bindingId, expectedRevision: offer.expectedRevision, policy: offer.policy });
    const result = await host.executeAction({
        pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1,
    }, input, options);
    const approval = ProtocolActionApprovalRequestCreatedResultSchema.safeParse(result);
    if (approval.success) return approval.data;
    return SessionPullRequestWatchResultV1Schema.parse(result);
}

/** c3 opens 08's form only. It never starts a process, grants rounds, changes a watch or fetches GitHub. */
export async function openTriagePullRequestLocalFormV1(
    host: TriagePullRequestControlHostV1,
    input: Readonly<{ session: ActionSessionAddressV1; binding: Binding; cause?: TriagePullRequestLocalCauseV1 }>,
    options?: PluginCancellationOptions,
) {
    throwIfAborted(options?.signal);
    const state = await host.readSession(input.session.sessionId, options);
    throwIfAborted(options?.signal);
    if (state === null || state.sessionId !== input.session.sessionId || state.serverId !== input.session.serverId)
        return { kind: 'unavailable' as const, reason: 'sessionUnavailable' as const };
    const accepted = SessionAcceptedWorkspaceV1Schema.safeParse(state.acceptedWorkspace);
    if (!accepted.success || accepted.data.checkout.serverId !== input.session.serverId)
        return { kind: 'unavailable' as const, reason: 'workspaceUnavailable' as const };
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: input.binding.link.repository };
    if (accepted.data.repository === undefined || !sameScmHostingRepositoryIdentity(repository, accepted.data.repository)
        || (input.cause !== undefined && !sameScmHostingRepositoryIdentity(repository, input.cause.repository)))
        return { kind: 'unavailable' as const, reason: 'repositoryMismatch' as const };
    const seed = {
        target: { kind: 'session', sessionId: input.session.sessionId },
        workspace: accepted.data.checkout,
        ...(input.cause?.workflowPath === undefined ? {} : { workflowPath: input.cause.workflowPath }),
        ...(input.cause?.sourceHeadSha === undefined ? {} : { sourceHeadSha: input.cause.sourceHeadSha }),
    };
    return host.executeAction({ pluginId: 'happier.scm.forge.github', localId: 'github/actions/local-form' },
        { operation: { kind: 'open', seed } }, options);
}
