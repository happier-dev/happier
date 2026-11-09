import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionIdSchema} from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SESSION_DRAFT_V2_ROUTE_READ } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { renderHook } from '@/dev/testkit';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { useNewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import { useNewSessionDraftActions } from '@/components/sessions/new/hooks/screenModel/useNewSessionDraftActions';
import { useNewSessionMachinePathState } from '@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState';
import type { NewSessionDraftModelIntent } from '@happier-dev/protocol/actions/appShellActionFamily';
import { act } from 'react-test-renderer';

const navigation = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: (route: unknown) => navigation.pushes.push(route) },
}).module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createAppShellAction } = await import('./appShellAction');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { writeNewSessionDraft, resetSessionDraftRepositoryForTests, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let serverId: string;
let accountId: string;
const draftId = '00000000-0000-4000-8000-000000000081';

beforeEach(async () => {
    storage.setState(originalState, true);
    resetSessionDraftRepositoryForTests();
    navigation.pushes.length = 0;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', true)) throw new Error('Draft feature fixture is unavailable');
    account = await createSecretSettingsTestHarness({ features });
    ({ serverId, accountId } = account.scope);
    writeNewSessionDraft({ scope: account.scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Keep the saved prompt' } });
});
afterEach(async () => {
    await account?.dispose();
    account = undefined;
    resetSessionDraftRepositoryForTests();
    storage.setState(originalState, true);
});

describe('saved New Session draft Action', () => {
    it('selects a model on the exact mounted draft through admission and refuses disabled mutation', async () => {
        if (!account) throw new Error('Account fixture missing');
        const selected: unknown[] = [];
        const scope = account.scope;
        const hook = await renderHook(() => {
            const document = useNewSessionComposerDocument({
            draftId, draftScope: account!.scope, promptStore: createNewSessionPromptStore('Keep the saved prompt'),
            persistedAttachments: [], composerAttachmentEntriesById: {}, scopeKey: 'model-action',
            canSubmitRef: { current: true }, isSubmitting: false,
            applyModelIntent: async intent => { selected.push(intent); return true; },
            });
            return { document, actions: useNewSessionDraftActions(document.ref, scope) };
        });
        try {
            const actionId = ActionIdSchema.parse('session.draft.model.set');
            const model = { kind: 'mode', modelId: 'custom-model' };
            const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, runtimeAccountId: accountId };
            const executor = createDefaultActionExecutor();
            expect(await executor.execute(actionId, { ref: hook.getCurrent().document.ref, model }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
            expect(selected).toEqual([model]);
            const selections: NewSessionDraftModelIntent[] = [
                { kind: 'selection', ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-model' } },
                { kind: 'team', selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
                    expectedResourceRevision: 1, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model', deliveryMode: 'brokered' } },
                { kind: 'team', selection: null },
            ];
            for (const selection of selections) {
                expect(await hook.getCurrent().actions.setModel(selection)).toBe(true);
            }
            expect(selected).toEqual([model, ...selections]);
            account.replaceSettings(settingsParse({ ...storage.getState().settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }),
            }));
            expect(await executor.execute(actionId, { ref: hook.getCurrent().document.ref, model }, context))
                .toMatchObject({ ok: false, errorCode: 'action_disabled' });
            expect(await hook.getCurrent().actions.setModel({ kind: 'mode', modelId: 'bypassed-model' })).toBe(false);
            expect(selected).toEqual([model, ...selections]);
        } finally { await hook.unmount(); }
    });
    it('applies UI folder choose/remove through the same admitted mounted-draft directory Action', async () => {
        if (!account) throw new Error('Account fixture missing');
        const scope = account.scope;
        const promptStore = createNewSessionPromptStore('Keep the saved prompt');
        const hook = await renderHook(() => {
            const paths = useNewSessionMachinePathState({ serverId, machines: [], recentMachinePaths: [],
                machineIdParam: null, pathParam: '/repo' });
            const document = useNewSessionComposerDocument({ draftId, draftScope: scope, promptStore,
                persistedAttachments: [], composerAttachmentEntriesById: {}, scopeKey: 'folder-action',
                canSubmitRef: { current: true }, isSubmitting: false, setDirectoryIntent: paths.setDirectoryIntent });
            return { paths, actions: useNewSessionDraftActions(document.ref, scope) };
        });
        try {
            await act(async () => { expect(await hook.getCurrent().actions.setDirectory({ kind: 'managed' })).toBe(true); });
            expect(hook.getCurrent().paths.directoryIntent).toEqual({ kind: 'managed' });
            await act(async () => { expect(await hook.getCurrent().actions.setDirectory({ kind: 'path', path: '/chosen' })).toBe(true); });
            expect(hook.getCurrent().paths.directoryIntent).toEqual({ kind: 'path', path: '/chosen' });
            account.replaceSettings(settingsParse({ ...storage.getState().settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.draft.directory.set': { enabled: false } } }),
            }));
            await act(async () => { expect(await hook.getCurrent().actions.setDirectory({ kind: 'managed' })).toBe(false); });
            expect(hook.getCurrent().paths.directoryIntent).toEqual({ kind: 'path', path: '/chosen' });
            expect(promptStore.getPrompt()).toBe('Keep the saved prompt');
        } finally { await hook.unmount(); }
    });
    it('opens the exact persisted draft and Home without replacing its prompt or creating another draft', async () => {
        const actionId = ActionIdSchema.parse('session.draft.open');
        const before = getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId });
        const result = await createDefaultActionExecutor().execute(actionId, { draftId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: true, result: { status: 'opened', draftId } });
        expect(navigation.pushes).toEqual([{ pathname: '/new', params: {
            draftId, spawnServerId: serverId, draftServerId: serverId, draftAccountId: accountId,
        } }]);
        expect(getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId })).toEqual(before);
    });
    it('does not navigate when draft opening is disabled', async () => {
        const actionId = ActionIdSchema.parse('session.draft.open');
        if (!account) throw new Error('Account fixture missing');
        account.replaceSettings(settingsParse({ ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }),
        }));
        const result = await createDefaultActionExecutor().execute(actionId, { draftId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(navigation.pushes).toEqual([]);
    });
    it('reports a missing draft without opening or creating one', async () => {
        if (!account) throw new Error('Account fixture missing');
        const originalRequest = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (...[input, init]: Parameters<RuntimeFetch>) => new URL(String(input)).pathname === SESSION_DRAFT_V2_ROUTE_READ
            ? Response.json({ status: 'absent' }) : originalRequest(input, init));
        const missingId = '00000000-0000-4000-8000-000000000099';
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.draft.open'), { draftId: missingId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: true, result: { status: 'missing' } });
        expect(navigation.pushes).toEqual([]);
        expect(getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId: missingId })).toBeNull();
    });
    it('refuses another Account when supplied the captured saved-draft owner', async () => {
        const owner = await captureLazyActionAccountContext(serverId);
        try {
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ appShellAction: createAppShellAction(owner) }));
            const result = await executor.execute(ActionIdSchema.parse('session.draft.open'), { draftId },
                { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'another-account' });
            expect(result).toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(navigation.pushes).toEqual([]);
        } finally { owner.dispose(); }
    });
});
