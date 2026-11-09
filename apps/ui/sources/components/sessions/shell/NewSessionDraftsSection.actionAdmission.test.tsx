import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SESSION_DRAFT_V2_ROUTE_MUTATE } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SESSION_DRAFT_ROUTE_MUTATE } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { FocusReturnProvider } from '@/keyboard/focusReturn';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getSessionDraftSnapshot, writeNewSessionDraft, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { NewSessionDraftsSection, NewSessionDraftsSectionView } from './NewSessionDraftsSection';
import 'fake-indexeddb/auto';
import { getSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { Modal } from '@/modal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
beforeEach(async () => {
    const persistence = getSessionDraftPersistenceStorage();
    if ('prepare' in persistence) await persistence.prepare();
});
afterEach(() => { standardCleanup(); resetSessionDraftRepositoryForTests(); clearMachineRequestReachabilityForTest(); });

it('marks a retained machine draft unavailable when requests fail without changing its target', async () => {
    const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
    const draftId = '00000000-0000-4000-8000-000000000092';
    const machine = createMachineFixture({ id: 'draft-target', activeAt: Date.now() });
    const request = account.request.getMockImplementation();
    if (!request) throw new Error('Expected installed Home HTTP boundary');
    const row = createPlainMachineRowFixture({ id: machine.id, accountId: account.scope.accountId });
    account.request.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines') return Response.json([row]);
        if (path === `/v1/machines/${machine.id}`) return Response.json({ machine: row });
        return request(input, init);
    });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.scope.serverId]: [machine] },
        machineListStatusByServerId: { [account.scope.serverId]: 'idle' } });
    writeNewSessionDraft({ scope: account.scope, draftId, materializationIntent: 'userEdit',
        patch: { text: 'Retain target', authoring: {
            executionTarget: { kind: 'machine', target: { serverId: account.scope.serverId, machineId: machine.id } },
        } } });
    const address = { kind: 'newSession' as const, draftId };
    expect(getSessionDraftSnapshot(account.scope, address)?.document).toMatchObject({
        v: 2, target: { kind: 'newSession', authoring: {
            executionTarget: { value: { kind: 'machine', target: { serverId: account.scope.serverId, machineId: machine.id } } },
        } },
    });
    try {
        const screen = await renderScreen(<FocusReturnProvider><NewSessionDraftsSection /></FocusReturnProvider>);
        expect(screen.getTextContent()).not.toContain('sessionDrafts.availability.machineUnavailable');
        await act(async () => recordMachineRequestFailed({ ...account.scope, machineId: machine.id }));
        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId[account.scope.serverId]).toBe('idle');
            expect(screen.getTextContent()).toContain('sessionDrafts.availability.machineUnavailable');
        });
    } finally { standardCleanup(); await account.dispose(); }
});

it('retains the draft without issuing a tombstone when the canonical delete Action is disabled', async () => {
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', true)) throw new Error('Draft feature fixture is unavailable');
    const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.draft.delete': { enabled: false } } }),
    }) });
    const draftId = '00000000-0000-4000-8000-000000000091';
    writeNewSessionDraft({ scope: account.scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Keep this draft' } });
    const address = { kind: 'newSession' as const, draftId };
    const before = getSessionDraftSnapshot(account.scope, address);
    try {
        const screen = await renderScreen(<FocusReturnProvider><NewSessionDraftsSection /></FocusReturnProvider>);
        expect(screen.findByTestId(`session-draft-delete:new-session:${draftId}`)).not.toBeNull();
        // The native press deliberately fire-and-forgets. Await its real mounted
        // view callback so a negative assertion cannot race the asynchronous delete.
        await act(async () => { await screen.findByType(NewSessionDraftsSectionView).props.onDelete(draftId, account.scope); });
        const tombstones = account.request.mock.calls.filter(([url, init]) => {
            const path = new URL(String(url)).pathname;
            if ((path !== SESSION_DRAFT_V2_ROUTE_MUTATE && path !== SESSION_DRAFT_ROUTE_MUTATE) || typeof init?.body !== 'string') return false;
            const input: unknown = JSON.parse(init.body);
            return input !== null && typeof input === 'object' && 'content' in input && input.content === null;
        });
        expect(tombstones).toEqual([]);
        expect(getSessionDraftSnapshot(account.scope, address)).toEqual(before);
    } finally { standardCleanup(); await account.dispose(); }
});

it('discards through the waived delete Action without a separate local confirmation', async () => {
    const account = await createSecretSettingsTestHarness({ settings: settingsParse({
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.draft.delete': ['ui'] } }),
    }) });
    const draftId = '00000000-0000-4000-8000-000000000094';
    const address = { kind: 'newSession' as const, draftId };
    writeNewSessionDraft({ scope: account.scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Discard waived draft' } });
    const confirm = vi.spyOn(Modal, 'confirm');
    try {
        const screen = await renderScreen(<FocusReturnProvider><NewSessionDraftsSection /></FocusReturnProvider>);
        let deleted = false;
        await act(async () => { deleted = await screen.findByType(NewSessionDraftsSectionView).props.onDelete(draftId, account.scope); });
        expect(deleted).toBe(true);
        expect(getSessionDraftSnapshot(account.scope, address)).toBeNull();
        expect(confirm).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); standardCleanup(); await account.dispose(); }
});
