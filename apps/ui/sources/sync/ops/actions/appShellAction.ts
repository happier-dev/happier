import { AppShellActionInputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { executeSessionBulkAction } from '@/components/sessions/actions/sessionBulkActionExecution';
import { SESSION_BULK_ACTION_IDS } from '@/components/sessions/actions/sessionBulkActionTypes';
import { isNewSessionDraftDeletionBlocked } from '@/components/sessions/drafts/newSessionDraftDeletion';
import { readAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { sessionSetManualReadStateWithServerScope } from '@/sync/ops';
import {
    deleteSessionDraft, deleteSessionDraftWithScopedRuntime, getSessionDraftSnapshot,
    materializeExactSessionDraftWithScopedRuntime,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { runWithSessionDraftRepositoryScopedRuntime } from '@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { applyRegisteredNewSessionDirectoryIntent } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { invokeMountedWorkRead } from './mountedWorkReadAction';
import { sync } from '@/sync/sync';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';

/** Thin projection of the incumbent bulk-acknowledgement and draft-repository owners. */
export function createAppShellAction(accountContext?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['appShellAction']> {
    return async ({ actionId, input, context }) => {
        if (actionId === 'session.draft.append') {
            context.signal?.throwIfAborted();
            const serverId = accountContext?.serverId ?? context.serverId;
            if (!serverId) return { status: 'unavailable' };
            const account = accountContext ?? await captureLazyActionAccountContext(serverId, context.signal);
            try {
                account.assertCurrent();
                if ((context.serverId && !areServerProfileIdentifiersEquivalent(account.serverId, context.serverId))
                    || (context.runtimeAccountId && context.runtimeAccountId !== account.accountId)) return { status: 'unavailable' };
                const { sessionId, text, sourceSessionId } = AppShellActionInputSchemas[actionId].parse(input);
                const createdAtMs = Date.now();
                await sync.patchSessionMetadataWithRetry(sessionId, metadata => writeSessionInitialPromptV1({
                    metadata, text, mode: 'append', createdAtMs, sourceSessionId,
                }), { serverId: account.serverId, accountLifetime: account.accountOnlyLifetime });
                account.assertAccountCurrent();
                return { status: 'appended', sessionId, createdAtMs };
            } finally { if (!accountContext) account.dispose(); }
        }
        if (actionId === 'session.work.get' || actionId === 'inbox.get') {
            if (!context.serverId || !context.runtimeAccountId) return { status: 'unavailable' };
            const account = accountContext ?? await captureLazyActionAccountContext(context.serverId, context.signal);
            try {
                account.assertCurrent();
                if (!areServerProfileIdentifiersEquivalent(account.serverId, context.serverId)
                    || account.accountId !== context.runtimeAccountId) return { status: 'unavailable' };
                const result = await invokeMountedWorkRead({ actionId, input,
                    context: { ...context, serverId: account.serverId, runtimeAccountId: account.accountId } });
                account.assertCurrent();
                return result;
            } finally { if (!accountContext) account.dispose(); }
        }
        if (actionId === 'session.draft.directory.set') {
            context.signal?.throwIfAborted();
            accountContext?.assertCurrent();
            const expectedServerId = accountContext?.serverId ?? context.serverId ?? undefined;
            const expectedAccountId = accountContext?.accountId ?? context.runtimeAccountId;
            if (accountContext && context.serverId
                && !areServerProfileIdentifiersEquivalent(accountContext.serverId, context.serverId)) return { status: 'unavailable' };
            if (accountContext && context.runtimeAccountId && accountContext.accountId !== context.runtimeAccountId) return { status: 'unavailable' };
            const { ref, directory } = AppShellActionInputSchemas[actionId].parse(input);
            return { status: applyRegisteredNewSessionDirectoryIntent(ref, directory, {
                ...(expectedServerId ? { serverId: expectedServerId } : {}),
                ...(expectedAccountId ? { accountId: expectedAccountId } : {}),
            }) ? 'applied' : 'unavailable' };
        }
        if (actionId === 'inbox.mark_all_read') {
            const { targets } = AppShellActionInputSchemas[actionId].parse(input);
            const result = await executeSessionBulkAction({
                action: { id: SESSION_BULK_ACTION_IDS.markRead },
                targets: targets.map((target) => ({ ...target, key: sessionAddressKey(target), readState: 'unread' })),
                context: {
                    setManualReadState: (target, state) => sessionSetManualReadStateWithServerScope(target.sessionId, state, { serverId: target.serverId }),
                    ...(context.signal ? { cancelSignal: { isCancelled: () => context.signal?.aborted === true } } : {}),
                },
            });
            return { results: result.results.map(({ target, status }) => ({ serverId: target.serverId, sessionId: target.sessionId, status })) };
        }
        const { draftId } = AppShellActionInputSchemas[actionId].parse(input);
        const serverId = context.serverId ?? getActiveServerAccountScope()?.serverId;
        if (!serverId && !accountContext) return { status: 'unavailable' };
        const account = accountContext ?? await captureLazyActionAccountContext(serverId!, context.signal);
        try {
            account.assertCurrent();
            const scope = account.accountLifetime.scope;
            const address = { kind: 'newSession' as const, draftId };
            const disposition = () => {
                account.assertCurrent();
                const draft = getSessionDraftSnapshot(scope, address);
                if (!draft) return 'missing' as const;
                return isNewSessionDraftDeletionBlocked({ draft, accountId: scope.accountId, operations: readAllActionOperations() })
                    ? 'launch_custody' as const : 'deletable' as const;
            };
            if (areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) {
                const status = disposition();
                if (status !== 'deletable') return { status };
                const deleted = await deleteSessionDraft({ scope, address });
                account.assertCurrent();
                return { status: deleted ? 'deleted' : 'unavailable' };
            }
            const result = await runWithSessionDraftRepositoryScopedRuntime({
                binding: account.accountLifetime,
                activeRequest: account.request,
                operation: async ({ scope, runtime, isCurrent }) => {
                    await materializeExactSessionDraftWithScopedRuntime({ scope, address, runtime, isCurrent });
                    const status = disposition();
                    if (status !== 'deletable') return { status };
                    const deleted = await deleteSessionDraftWithScopedRuntime({ scope, address, runtime, isCurrent });
                    account.assertCurrent();
                    return { status: deleted ? 'deleted' as const : 'unavailable' as const };
                },
            });
            account.assertCurrent();
            return result ?? { status: 'unavailable' };
        } finally {
            if (!accountContext) account.dispose();
        }
    };
}
