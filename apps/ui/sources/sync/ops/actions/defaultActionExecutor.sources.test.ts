import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

// Only the network, device credential store and disconnected socket boundary
// are replaced. Account capture, settings, admission and Source dispatch stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await homes.reset(); });

describe('Source admission through the default Account Action host', () => {
    it('uses the Source input Home and its actual credential across all admitted surfaces when focus is elsewhere', async () => {
        const serverId = await homes.addHome({ name: 'Named Source Home', serverUrl: 'https://named-source-actions.test', accountId: 'named-account', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-source-actions.test', accountId: 'focused-account' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        for (const surface of ['ui', 'voice', 'agent', 'mcp', 'cli'] as const) {
            expect(await executor.execute('projects.sources.list', { serverId }, { surface })).toMatchObject({
                ok: true, result: { ok: true, sources: [] },
            });
        }
        expect(homes.requestsFor(path).map(request => ({ serverId: request.serverId, token: request.token })))
            .toEqual(Array.from({ length: 5 }, () => ({ serverId, token: createAccountTokenForTests('named-account') })));
        expect(homes.requests.some(request => request.path.startsWith('/v1/projects/sources') && request.serverId !== serverId)).toBe(false);
    });

    it('captures actual Home credentials and refuses another Account or Home before Source disclosure', async () => {
        const serverId = await homes.addHome({ name: 'Source Home', serverUrl: 'https://source-actions.test', accountId: 'account-a' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('projects.sources.list', { serverId }, { serverId, surface: 'ui', expectedAccountId: 'account-a' }))
            .toMatchObject({ ok: true, result: { ok: true, sources: [] } });
        const before = homes.requestsFor(path).length;
        expect(await executor.execute('projects.sources.list', { serverId }, { serverId, surface: 'ui', expectedAccountId: 'account-b' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(await executor.execute('projects.sources.list', { serverId: 'another-home' }, { serverId, surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(path)).toHaveLength(before);
    });

    it('does not let external provenance from another Account borrow this Home bearer', async () => {
        const serverId = await homes.addHome({ name: 'Source Home', serverUrl: 'https://source-external-actions.test', accountId: 'account-a' });
        const path = `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}`;
        homes.answer(serverId, path, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
        const executor = createDefaultActionExecutor();
        const context = {
            serverId, surface: 'cli', externalActionCredential: { accountId: 'account-b', principalId: 'principal-b',
                credentialId: 'credential-b', grant: API_TOKEN_FULL_GRANT_V1 },
        } as const;
        const result = await executor.execute('projects.sources.list', { serverId }, context);
        expect(result.ok).toBe(false);
        expect(await executor.prepare('projects.sources.list', { serverId }, context)).toMatchObject({
            kind: 'settled', result: { ok: false, errorCode: 'action_account_scope_changed' },
        });
        expect(homes.requestsFor(path)).toEqual([]);
    });
});
