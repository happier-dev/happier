import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import type { CurrentUiContextResolvedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Recipient-envelope APIs are network boundaries and are not used by this local continuation.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Continuation reached recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
let unregister: (() => void) | undefined;

describe('authenticated Account Home continuation Action', () => {
    beforeEach(async () => { await harness.reset(); });
    afterEach(() => { unregister?.(); unregister = undefined; standardCleanup(); });

    it('persists an Agent request in the same Account and runs the current mounted continuation only after its human decision', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://continuation-home.test',
            serverIdentityId: 'continuation-home', accountId: 'alice' });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        let effects = 0;
        const retirement = new AbortController();
        const command: CurrentUiContextResolvedCommand = { id: 'current-ui:continuation', retirementSignal: retirement.signal,
            command: { kind: 'accountHomeContinuation', operation: 'refresh',
                account: { scope, isCurrent: () => !retirement.signal.aborted, onRetire: () => ({ dispose() {} }) },
                invoke: async () => { effects += 1; return { status: 'completed' }; } } };
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'account', screen: 'continuation' },
                commands: [{ id: command.id, title: 'Refresh Homes' }] }),
                resolveCurrentUiCommand: id => id === command.id && !retirement.signal.aborted ? command : null,
                subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createDefaultActionExecutor();
        const request = await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, {
            surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'alice',
        });
        expect(request).toMatchObject({ ok: true });
        if (!request.ok) throw new Error(request.error);
        const created = ActionApprovalRequestCreatedResultSchema.parse(request.result);
        expect(created.actionId).toBe('account.home_continuation.invoke');
        expect(effects).toBe(0);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(created.artifactId) ?? 'null'))
            .toMatchObject({ actionId: created.actionId, actionArgs: { operation: 'refresh', commandId: command.id },
                executionOriginV1: { accountId: 'alice' } });
        expect(await executor.execute('approval.request.decide', { artifactId: created.artifactId, decision: 'approve' }, {
            surface: 'ui', serverId, expectedAccountId: 'alice',
        })).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(effects).toBe(1);

        const stale = await executor.execute('account.home_continuation.invoke', { operation: 'refresh', commandId: command.id }, {
            surface: 'agent', serverId, expectedAccountId: 'alice',
        });
        if (!stale.ok) throw new Error(stale.error);
        const staleApproval = ActionApprovalRequestCreatedResultSchema.parse(stale.result);
        retirement.abort();
        expect(await executor.execute('approval.request.decide', { artifactId: staleApproval.artifactId, decision: 'approve' }, {
            surface: 'ui', serverId, expectedAccountId: 'alice',
        })).toMatchObject({ ok: true, result: { status: 'failed' } });
        expect(effects).toBe(1);
    });
});
