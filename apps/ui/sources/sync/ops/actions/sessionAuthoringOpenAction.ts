import { buildNewSessionAuthoringDraftFromTempData, buildNewSessionTempDataFromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringPresentation } from '@/components/sessions/new/newSessionSeedNavigation';
import type { SessionAuthoringOpenResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { openOrdinaryNewSessionSeed } from '@/components/sessions/new/newSessionSeedNavigation';
import { buildNewSessionConfigurationDraft, buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';

type AuthoringOpenArgs = Parameters<NonNullable<ActionExecutorDeps['sessionAuthoringOpen']>>[0];

async function openSourceSessionDraft({ input, context }: AuthoringOpenArgs,
    capturedAccount?: LazyActionAccountContext, presentation?: SessionAuthoringPresentation): Promise<SessionAuthoringOpenResultV1> {
    if (!('sourceSession' in input)) return { kind: 'invalid', reason: 'seed_invalid' };
    const address = input.sourceSession;
    if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, address.serverId)) {
        return { kind: 'stale', reason: 'host_retired' };
    }
    let account = capturedAccount;
    try {
        account ??= await captureLazyActionAccountContext(address.serverId, context.signal);
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(account.serverId, address.serverId)
            || (context.runtimeAccountId && context.runtimeAccountId !== account.accountId)) {
            return { kind: 'stale', reason: 'host_retired' };
        }
        const sourceAccount = account;
        const state = getStorage().getState();
        // Bare ids are not Account provenance. Only borrow a held detail from its owning scope.
        const held = account.credentialAuthorityKind === 'account'
            && areServerAccountScopesEqual(state.profileScope, account.accountLifetime.scope)
            ? selectSessionViewShellSessionForRouteState(state, address.sessionId, address.serverId)
            : null;
        const session = held ?? (await runWithServerRequestAuthorityForServerAccountScope({
            scope: account.accountLifetime.scope, activeRequest: account.request,
        }, authority => readSessionSnapshotForAuthority({ authority, sessionId: address.sessionId,
            signal: context.signal, isCurrent: sourceAccount.accountLifetime.isCurrent }))).session;
        account.assertCurrent();
        const metadata = readSessionOwnerMetadataView(session);
        if (session.access?.capabilities.readTranscript !== true
            || !isSessionContentReadable(readSessionContentAvailability(session)) || !metadata) {
            return { kind: 'unavailable', reason: 'origin_unavailable' };
        }
        const target = resolveMachineControlTargetForSessionFromState({ ...getStorage().getState(),
            sessions: { [session.id]: session }, sessionListRowsByServerId: {},
        }, { ...account.accountLifetime.scope, sessionId: session.id });
        const approvalProfileId = resolveSessionApprovalProfileReferenceV1(metadata);
        const approvalProfile = approvalProfileId && metadata.approvalProfileTeamOrGroupDerived !== true
            ? await account.readArtifactHeader(approvalProfileId, { signal: context.signal }) : null;
        let configuration = buildNewSessionTempDataFromSessionConfiguration({ session,
            machineId: target?.machineId ?? metadata.machineId ?? null,
            directoryOverride: target?.basePath ?? metadata.path ?? null, approvalProfile });
        if (input.seed?.directoryIntent?.kind === 'managed') {
            configuration = { ...configuration, directory: '', directoryKind: 'managed' };
        }
        if (input.connectedServices !== undefined) {
            configuration = buildNewSessionTempDataFromAuthoringDraft({
                draft: { ...buildNewSessionAuthoringDraftFromTempData(configuration), connectedServices: input.connectedServices },
                machineId: configuration.machineId ?? null,
            });
        }
        const machineId = configuration.machineId;
        const directory = configuration.directory;
        const outcome = await openOrdinaryNewSessionSeed({
            seed: { ...(machineId ? { placement: { kind: 'exactTarget', serverId: account.serverId, machineId, ...(directory ? { directory } : {}) } } : directory ? { placement: { kind: 'currentTarget', directory } } : {}), ...input.seed },
            ...(input.replay ? { sourceContextHandoff: { sourceContext: { v: 1, kind: 'session_replay', sourceSessionId: address.sessionId, forkPoint: input.replay }, sourceContextServerId: address.serverId } } : {}),
            ...(presentation ? { presentation } : {}),
            configurationDraft: buildNewSessionConfigurationDraft(configuration),
            scope: account.accountLifetime.scope, signal: context.signal, isCurrent: account.accountLifetime.isCurrent,
        });
        return outcome.kind === 'opened'
            ? { kind: 'opened', draftId: outcome.draftId, destination: 'newSession' } : outcome;
    } catch {
        if (context.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' };
        return account && !account.accountLifetime.isCurrent()
            ? { kind: 'stale', reason: 'host_retired' }
            : { kind: 'unavailable', reason: 'origin_unavailable' };
    } finally {
        if (account && account !== capturedAccount) account.dispose();
    }
}

/** Presentation only: the ordinary composer retains sole ownership of edits and explicit Send. */
export async function openSessionAuthoringDraft(args: AuthoringOpenArgs,
    capturedAccount?: LazyActionAccountContext, presentation?: SessionAuthoringPresentation): Promise<SessionAuthoringOpenResultV1> {
    const { input, context } = args;
    if ('sourceSession' in input) return openSourceSessionDraft(args, capturedAccount, presentation);
    const lifetime = capturedAccount?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime
        || (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, lifetime.scope.serverId))
        || (context.runtimeAccountId && context.runtimeAccountId !== lifetime.scope.accountId)) {
        return { kind: 'stale', reason: 'host_retired' };
    }
    const pluginId = context.actionCaller?.kind === 'plugin' ? context.actionCaller.pluginId : undefined;
    const outcome = await openOrdinaryNewSessionSeed({
        seed: input.seed,
        ...(presentation ? { presentation } : {}),
        ...(pluginId ? { pluginId } : {}),
        scope: lifetime.scope,
        ...(context.signal ? { signal: context.signal } : {}),
        isCurrent: lifetime.isCurrent,
    });
    return outcome.kind === 'opened'
        ? { kind: 'opened', draftId: outcome.draftId, destination: 'newSession' }
        : outcome;
}
