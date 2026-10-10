import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';

import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { peekTempData } from '@/utils/sessions/tempDataStore';
import { openNewSessionSourceContextNavigation } from './newSessionSourceContextNavigation';
import { resolveNewSessionDraftRouteScope } from './newSessionDraftRouteIdentity';
installFileFindAccountBoundaryMocks('server-a', 'account-a');

describe('openNewSessionSourceContextNavigation', () => {
    beforeEach(async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
    });
    it('keeps a continuation draft in the source Home Account rather than the focused Home', () => {
        const navigate = vi.fn();
        const outcome = openNewSessionSourceContextNavigation({
            session: createSessionFixture({ id: 'source-session' }), sourceSessionId: 'source-session',
            forkPoint: { type: 'latest' }, serverId: 'source-home', machineId: null,
            accountLifetime: { scope: { serverId: 'source-home', accountId: 'source-account' },
                isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            createDraftId: () => 'cd5ae585-2a80-48ef-9d4b-521bf537d529', navigateToNewSession: navigate,
        });
        expect(outcome.kind).toBe('opened');
        const route = navigate.mock.calls[0][0];
        expect(resolveNewSessionDraftRouteScope({
            activeScope: { serverId: 'server-a', accountId: 'account-a' },
            draftServerId: route.params.draftServerId, draftAccountId: route.params.draftAccountId,
            requestedScopeResolution: { kind: 'bound', scope: { serverId: 'source-home', accountId: 'source-account' } },
        })).toEqual({ serverId: 'source-home', accountId: 'source-account' });
        expect(readNewSessionDraftFromRepository({ scope: { serverId: 'source-home', accountId: 'source-account' }, draftId: route.params.draftId }))
            .toMatchObject({ selectedMachineId: null, executionTarget: null });
        expect(readNewSessionDraftFromRepository({ scope: { serverId: 'server-a', accountId: 'account-a' }, draftId: route.params.draftId })).toBeNull();
    });
    it('routes every source-context seed into a fresh exact draft identity', () => {
        const navigate = vi.fn();
        const outcome = openNewSessionSourceContextNavigation({
            session: createSessionFixture({ id: 'source-session' }),
            sourceSessionId: 'source-session',
            forkPoint: { type: 'latest' },
            serverId: 'server-a',
            machineId: 'machine-a',
            createDraftId: () => '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            restoredDraftText: 'Continue from this edited message',
            navigateToNewSession: navigate,
        });
        expect(outcome.kind).toBe('opened');
        const route = navigate.mock.calls[0][0];
        expect(route.params.draftId).toBe('4a506d8a-85bd-4c42-a662-6f502f3acc45');
        expect(readNewSessionDraftFromRepository({ scope: { serverId: 'server-a', accountId: 'account-a' }, draftId: route.params.draftId }))
            .toMatchObject({ input: 'Continue from this edited message', selectedMachineId: 'machine-a' });
        expect(peekTempData(route.params.dataId)).toEqual({ sourceContext: {
            v: 1, kind: 'session_replay', sourceSessionId: 'source-session', forkPoint: { type: 'latest' },
        }, sourceContextServerId: 'server-a' });
    });
});
