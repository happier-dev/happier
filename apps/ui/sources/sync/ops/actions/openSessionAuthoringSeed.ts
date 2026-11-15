import type { PluginUiNewSessionSeedV1, SessionAuthoringOpenV1 } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScopeLifetime, ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { SessionAuthoringPresentation } from '@/components/sessions/new/newSessionSeedNavigation';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { openSessionAuthoringAction, type SessionAuthoringOpenOutcome } from './sessionAuthoringActions';

type SourceInput = Extract<SessionAuthoringOpenV1, { sourceSession: unknown }>;
export type SessionAuthoringSeedInput = SessionAuthoringPresentation & Readonly<{
    seed?: PluginUiNewSessionSeedV1;
    sourceSession?: SourceInput['sourceSession'];
    replay?: SourceInput['replay'];
    connectedServices?: SourceInput['connectedServices'];
    accountLifetime?: ServerAccountScopeLifetime;
    scope: ServerAccountScope;
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>;

/** First-party presentation adapter. Only the admitted Action may seed the draft. */
export async function openSessionAuthoringSeed(params: SessionAuthoringSeedInput): Promise<SessionAuthoringOpenOutcome> {
    const lifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime) {
        return { kind: 'stale', reason: 'host_retired' };
    }
    const execute = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
        navigateToNewSession: params.navigateToNewSession, createDraftId: params.createDraftId, isCurrent: params.isCurrent,
    } });
    const input: SessionAuthoringOpenV1 = params.sourceSession
        ? { sourceSession: params.sourceSession, seed: params.seed, replay: params.replay, connectedServices: params.connectedServices }
        : { seed: params.seed ?? {} };
    return openSessionAuthoringAction(input, lifetime, { signal: params.signal, isCurrent: params.isCurrent,
        executeAction: (_actionId, value, options) => execute('session.authoring.open', value, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId: params.scope.serverId, expectedAccountId: params.scope.accountId,
            signal: options?.signal }) });
}
