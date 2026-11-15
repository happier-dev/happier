import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { peekTempData } from '@/utils/sessions/tempDataStore';
import { openNewSessionSourceContextNavigation } from './newSessionSourceContextNavigation';
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries({ ...homes, request: createSessionReadBatchFetchBoundary(homes.request) });
let scope = { serverId: '', accountId: 'account-a' };
beforeEach(async () => {
    await homes.reset();
    scope = { serverId: await homes.addHome({ name: 'Authoring', serverUrl: 'https://continuation.test', accountId: 'account-a', currentAccount: true }), accountId: 'account-a' };
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://continuation.test', generation: 1 });
    storage.getState().activateProfileScope(scope);
});
afterEach(async () => { resetSessionDraftRepositoryForTests(); publishAppliedActiveServerRuntimeAvailability(false); await homes.reset(); });
describe('openNewSessionSourceContextNavigation', () => {
    it('opens the admitted editable continuation with restored text and exact replay cutoff', async () => {
        const session = createSessionFixture({ id: 'source-session', serverId: scope.serverId,
            metadata: { path: '/repo', host: 'dev', machineId: 'machine-a', flavor: 'codex' } });
        storage.getState().applySessions([session]);
        const navigate = vi.fn();
        const outcome = await openNewSessionSourceContextNavigation({ sourceSessionId: session.id,
            forkPoint: { type: 'latest' }, serverId: scope.serverId,
            createDraftId: () => 'continuation-draft', restoredDraftText: 'Continue from this edited message', navigateToNewSession: navigate });
        expect(outcome.kind).toBe('opened');
        const route = navigate.mock.calls[0]![0];
        expect(route.params).toMatchObject({ draftId: 'continuation-draft', draftServerId: scope.serverId, draftAccountId: scope.accountId });
        expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId }))
            .toMatchObject({ input: 'Continue from this edited message', selectedMachineId: 'machine-a' });
        expect(peekTempData(route.params.dataId)).toEqual({ sourceContext: {
            v: 1, kind: 'session_replay', sourceSessionId: session.id, forkPoint: { type: 'latest' },
        }, sourceContextServerId: scope.serverId });
    });
    it('refuses a retired source Account without opening a draft', async () => {
        const navigate = vi.fn();
        expect(await openNewSessionSourceContextNavigation({ sourceSessionId: 'source-session',
            forkPoint: { type: 'latest' }, serverId: scope.serverId,
            accountLifetime: { scope, isCurrent: () => false, onRetire: () => ({ dispose() {} }) }, navigateToNewSession: navigate }))
            .toEqual({ kind: 'stale', reason: 'host_retired' });
        expect(navigate).not.toHaveBeenCalled();
    });
});
