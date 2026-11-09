import { afterEach, expect, it } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { storage } from '@/sync/domains/state/storage';
import { refreshSessionListProjection, type SessionReadInFlightEntry } from './listProjectionRead';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it('yields a superseded projection to its replacement while unrelated Account changes preserve the pending read and shown row', async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    let reads = 0;
    let hold = false;
    const boundary = createSessionReadBatchHttpBoundary(async request => {
        if (request.path !== '/v2/sessions/retained') return undefined;
        reads++;
        if (hold) { started.resolve(); await release.promise; }
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'retained', metadataVersion: reads }) });
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://projection-supersession.test', accountId: 'account-a' }],
        route: request => boundary.handle(request) });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const pendingReads = new Map<string, SessionReadInFlightEntry>();
        const refresh = (isScopeCurrent: () => boolean) => refreshSessionListProjection({ serverId: server.id,
            sessionId: 'retained', accountId: 'account-a', pendingReads, isScopeCurrent,
            read: { authority, activeCredentials: credentials, activeEncryption: authority.context.encryption,
                activeRequest: authority.request, sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(),
                applySessions: sessions => storage.getState().applySessions(sessions) },
            retireSession: () => { throw new Error('Supersession must not retire shown content'); }, deferHydration: () => {},
        });
        await refresh(() => true);
        const shown = storage.getState().sessionListRowsByServerId[server.id]!.retained;
        hold = true;
        let current = true;
        const first = refresh(() => current).then(() => 'yielded', () => 'failed');
        try {
            await started.promise;
            for (let index = 0; index < 100; index++) publishHomeAccountChange(server.id, ['unrelated-' + index], {
                source: 'socket', changeKinds: ['artifact'],
            });
            expect([...pendingReads.values()][0]!.isCurrent()).toBe(true);
            expect(reads).toBe(2);
            expect(storage.getState().sessionListRowsByServerId[server.id]!.retained).toBe(shown);
            current = false;
            const next = refresh(() => true).then(() => 'applied', () => 'failed');
            release.resolve();
            await expect(first).resolves.toBe('yielded');
            await expect(next).resolves.toBe('applied');
            expect(storage.getState().sessionListRowsByServerId[server.id]!.retained?.metadataVersion).toBeGreaterThan(shown!.metadataVersion);
            expect(pendingReads.size).toBe(0);
        } finally { release.resolve(); await first; }
    });
});
