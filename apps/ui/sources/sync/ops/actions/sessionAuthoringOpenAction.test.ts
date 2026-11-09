import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { openSessionAuthoringDraft } from './sessionAuthoringOpenAction';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
// Navigation is the platform boundary; source admission, rich copying and durable draft writes run for real.
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries({ ...homes, request: createSessionReadBatchFetchBoundary(homes.request) });
let scope = { serverId: '', accountId: 'authoring-account' };
beforeEach(async () => {
    await homes.reset();
    scope = { serverId: await homes.addHome({ name: 'Authoring', serverUrl: 'https://authoring.test', accountId: 'authoring-account', currentAccount: true }), accountId: 'authoring-account' };
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://authoring.test', generation: 1 });
    storage.getState().activateProfileScope(scope);
    navigation.push.mockClear();
});
afterEach(async () => {
    resetSessionDraftRepositoryForTests();
    publishAppliedActiveServerRuntimeAvailability(false);
    await homes.reset();
});

describe('source Session authoring Action', () => {
    it('opens a rich promptless managed-folder draft and refuses other Homes, locked content and retired Accounts', async () => {
        const source = createSessionFixture({ id: 'source', serverId: scope.serverId, metadata: {
            path: '/private/source', host: 'dev', machineId: 'source-machine', flavor: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            modelSelectionIntentV1: { v: 1, updatedAt: Date.now(), selection: {
                agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5',
            } },
            sessionDirectoryV1: { v: 1, kind: 'managed' }, profileId: 'source-profile',
            terminal: { mode: 'tmux', tmux: { target: 'source-pane' } },
        }, permissionMode: 'acceptEdits', permissionModeUpdatedAt: 100, modelMode: 'gpt-5', modelModeUpdatedAt: 101 });
        storage.getState().applySessions([source]);
        storage.getState().applySessionOrganizationSnapshot(scope.serverId, { schemaVersion: 1, version: 1,
            pins: [], folders: [], tags: [], orderEntries: [], labels: [],
            folderAssignments: [{ sessionId: source.id, folderId: 'source-section' }],
            tagAssignments: [{ sessionId: source.id, tagIds: ['source-tag'] }],
        });
        const context = { surface: 'ui' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
        const input = { sourceSession: { serverId: scope.serverId, sessionId: source.id } };
        const opened = await openSessionAuthoringDraft({ input, context });
        expect(opened.kind).toBe('opened');
        if (opened.kind !== 'opened') throw new Error('Authoring did not open');
        const draft = readNewSessionDraftFromRepository({ scope, draftId: opened.draftId });
        expect(draft).toMatchObject({ input: '', selectedMachineId: 'source-machine', selectedPath: null,
            directoryKind: 'managed', selectedProfileId: 'source-profile', permissionMode: 'safe-yolo',
            modelSelection: { ref: { modelId: 'gpt-5' } }, organizationPlacement: { folderId: null, tagIds: [] } });
        expect(JSON.stringify(draft)).not.toContain('/private/source');
        expect(draft?.resumeSessionId).toBeUndefined();
        expect(navigation.push).toHaveBeenCalledTimes(1);
        expect(await openSessionAuthoringDraft({ input: { sourceSession: { serverId: 'other-home', sessionId: source.id } }, context }))
            .toMatchObject({ kind: 'stale', reason: 'host_retired' });
        storage.getState().applySessions([{ ...source, encryptedContentAvailability: 'encrypted_content_unavailable' }]);
        expect(await openSessionAuthoringDraft({ input, context })).toMatchObject({ kind: 'unavailable' });
        await homes.switchAccount(scope.serverId, 'replacement-account');
        expect(await openSessionAuthoringDraft({ input, context })).toEqual({ kind: 'stale', reason: 'host_retired' });
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });

    it('copies the requested Home with a duplicate Session id while leaving the focused Home alone', async () => {
        const sourceHome = await homes.addHome({ name: 'Source', serverUrl: 'https://source-authoring.test', accountId: 'source-account', currentAccount: true });
        const source = createSessionFixture({ id: 'same', serverId: sourceHome, metadata: { path: '/source-home', host: 'source', machineId: 'source-machine', profileId: 'source-profile', flavor: 'codex' } });
        storage.getState().applySessions([createSessionFixture({ id: 'same', serverId: scope.serverId,
            metadata: { path: '/focused-home', host: 'focused', machineId: 'focused-machine', profileId: 'focused-profile' } })]);
        homes.answer(sourceHome, '/v2/sessions/same', { body: createPlainSessionByIdResponseFixture(source) });
        const result = await createFrontDoorActionExecute()('session.authoring.open', {
            sourceSession: { serverId: sourceHome, sessionId: 'same' },
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: sourceHome, expectedAccountId: 'source-account' });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        expect(opened.kind).toBe('opened');
        if (opened.kind !== 'opened') throw new Error('Source Home authoring did not open');
        expect(readNewSessionDraftFromRepository({ scope: { serverId: sourceHome, accountId: 'source-account' }, draftId: opened.draftId }))
            .toMatchObject({ selectedPath: '/source-home', selectedMachineId: 'source-machine', selectedProfileId: 'source-profile' });
        expect(navigation.push).toHaveBeenLastCalledWith({ pathname: '/new', params: expect.objectContaining({ draftId: opened.draftId, draftServerId: sourceHome, draftAccountId: 'source-account' }) });
        expect(storage.getState().profileScope).toEqual(scope);
    });
});
