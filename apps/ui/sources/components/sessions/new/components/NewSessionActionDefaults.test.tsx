import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { act, renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from '@/components/ui/forms/formsTestHelpers';
import { seedAndOpenNewSession } from '../newSessionSeedComposer';
import { readNewSessionDraftFromRepository, writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { clearBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import { discardSessionDraftPersistenceWrites, prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';

// IndexedDB transactions are the persistence boundary; repository hydration stays real.
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

installFormsCommonModuleMocks();

const scope = { serverId: 'server-a', accountId: 'account-a' };
const draftId = '00000000-0000-4000-8000-000000000042';
const actionDefault = { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, configuredActionId: 'fix-check', label: 'Fix check', launchMode: 'review' as const };

beforeEach(async () => { await prepareSessionDraftPersistenceStorage(); });
afterEach(async () => {
    await discardSessionDraftPersistenceWrites();
    resetSessionDraftRepositoryForTests();
    await clearBrowserRecords();
});

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

/** The configurator is a disclosure: open it when it is closed, then press its Save. */
async function pressSave(screen: RenderedScreen): Promise<void> {
    if (!screen.findByTestId('new-session-action-default-save')) await screen.pressByTestIdAsync('new-session-action-default-open');
    await screen.pressByTestIdAsync('new-session-action-default-save');
}

describe('NewSessionActionDefaults', () => {
    it('stays one quiet disclosure until opened and closes after a successful save', async () => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Keep this task', actionDefault }, scope,
            isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!draft) throw new Error('Expected the seeded draft');
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId}
            execute={vi.fn().mockResolvedValue({ v: 1, status: 'applied' })}
            getCurrentDraft={() => draft} onProfileSaved={() => undefined} />);
        expect(screen.findByTestId('new-session-action-default-name')).toBeFalsy();
        await screen.pressByTestIdAsync('new-session-action-default-open');
        expect(screen.findByTestId('new-session-action-default-name')?.props.value).toBe('Fix check');
        await screen.pressByTestIdAsync('new-session-action-default-save');
        expect(screen.findByTestId('new-session-action-default-name')).toBeFalsy();
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.saved');
        await screen.unmount();
    });

    it.each([
        { label: 'a draft seeded from a Triage action', seed: { prompt: 'Keep this task', actionDefault }, shown: true },
        { label: 'a draft not seeded from an action', seed: { prompt: 'Keep this task' }, shown: false },
        { label: 'a seed naming another plugin', seed: { prompt: 'Keep this task',
            actionDefault: { ...actionDefault, pluginId: 'happier.other' } }, shown: false },
    ])('offers the save only for $label', async ({ seed, shown }) => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed, scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!draft) throw new Error('Expected the seeded draft');
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={vi.fn()}
            getCurrentDraft={() => draft} onProfileSaved={() => undefined} />);
        expect(Boolean(screen.findByTestId('new-session-action-default-open'))).toBe(shown);
        await screen.unmount();
    });

    it.each([
        { label: 'untouched placement', patch: { executionTarget: undefined }, placement: 'automatic' },
        { label: 'explicit question', patch: { executionTarget: null }, placement: 'ask' },
        { label: 'no folder on a stable machine', patch: { directoryKind: 'managed' as const,
            executionTarget: { kind: 'machine' as const, target: { serverId: 'server-a', machineId: 'machine-a' } } },
            placement: { fixed: { serverId: 'server-a', machineId: 'machine-a' }, directoryIntent: { kind: 'managed' } } },
    ])('preserves $label as an action preference', async ({ patch, placement }) => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Keep this task', actionDefault }, scope,
            isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!draft) throw new Error('Expected the seeded draft');
        const execute = vi.fn().mockResolvedValue({ v: 1, status: 'applied' });
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={execute}
            getCurrentDraft={() => ({ ...draft, ...patch })} onProfileSaved={() => undefined} />);
        await pressSave(screen);
        expect(execute).toHaveBeenCalledWith('action.invoke', expect.objectContaining({ input: expect.objectContaining({ placement }) }));
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.saved');
        await screen.unmount();
    });

    it.each<Readonly<{ label: string; patch: Partial<NewSessionDraft> }>>([
        { label: 'a Temporary computer', patch: { executionTarget: { kind: 'temporary_computer', serverId: 'server-a',
            artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } } },
        { label: 'managed creation', patch: { managedMachineAcquisition: { requestId: 'request-a',
            selection: { kind: 'preset', homeId: 'server-a', id: 'preset-a', revision: 1 } } } },
        { label: 'a pool selection', patch: { executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' },
            selectionOrigin: { kind: 'machine_pool', poolId: '00000000-0000-4000-8000-000000000043' } } } },
    ])('explains that $label needs stable placement before saving', async ({ patch }) => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Keep this task', actionDefault }, scope,
            isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!draft) throw new Error('Expected the seeded draft');
        const execute = vi.fn();
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={execute}
            getCurrentDraft={() => ({ ...draft, ...patch })} onProfileSaved={() => undefined} />);
        await pressSave(screen);
        expect(execute).not.toHaveBeenCalled();
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.stablePlacementRequired');
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Keep this task');
        await screen.unmount();
    });

    it('saves the edited name and current composer text through the Action boundary', async () => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Original task', actionDefault, profileId: 'profile-a',
            placement: { kind: 'exactTarget', serverId: 'server-a', machineId: 'machine-a', directory: '/repo' } },
            scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const prior = readNewSessionDraftFromRepository({ scope, draftId });
        if (!prior) throw new Error('Expected the seeded draft');
        const calls: unknown[] = [];
        // Action execution is the effect boundary; repository and snapshot projection stay real.
        const execute = async (id: 'action.invoke', input: unknown) => {
            calls.push({ id, input });
            return { v: 1, status: 'applied', revision: '2', actions: [{ actionId: 'fix-check', label: 'Repair checks',
                enabled: true, appliesTo: ['issue'], profileId: 'profile-owned', workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: 'saved-prompt', delivery: 'send' } }] };
        };
        let currentAuthoring = prior;
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={execute}
            getCurrentDraft={() => currentAuthoring}
            onProfileSaved={(profileId: string | null) => { currentAuthoring = { ...currentAuthoring, selectedProfileId: profileId }; }} />);
        await screen.pressByTestIdAsync('new-session-action-default-open');
        await act(async () => { screen.findByTestId('new-session-action-default-name')?.props.onChangeText('Repair checks'); });
        await screen.pressByTestIdAsync('new-session-action-default-launch:start');
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...prior, selectedProfileId: 'profile-b',
            targetServerId: 'server-b', selectedMachineId: 'machine-b', selectedPath: '/other',
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'machine-b' } },
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'repair', baseRef: null, branchMode: 'new' } } });
        writeNewSessionDraft({ scope, draftId, patch: { text: 'The task currently in the composer' }, materializationIntent: 'userEdit' });
        const persisted = readNewSessionDraftFromRepository({ scope, draftId });
        if (!persisted) throw new Error('Expected the retained draft');
        // The model's current builder sees a control edit before its delayed autosave.
        currentAuthoring = { ...persisted, selectedProfileId: 'profile-current', selectedPath: '/current' };
        await pressSave(screen);
        expect(calls).toEqual([{ id: 'action.invoke', input: {
            action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'actions/administer-v1' },
            input: { v: 1, kind: 'saveDefaults', actionId: 'fix-check', label: 'Repair checks',
                promptText: 'The task currently in the composer', profileId: 'profile-current',
                placement: { fixed: { serverId: 'server-b', machineId: 'machine-b' }, directory: '/current' },
                checkout: 'create_worktree', launchMode: 'start' },
        } }]);
        expect(currentAuthoring.selectedProfileId).toBe('profile-owned');
        await pressSave(screen);
        expect(calls[1]).toMatchObject({ input: { input: { profileId: 'profile-owned' } } });
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.saved');
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('The task currently in the composer');
        await screen.unmount();
    });

    it.each([
        { refusal: { v: 1, status: 'unknownAction' }, feedback: 'newSession.actionDefault.failed' },
        { refusal: { v: 1, status: 'rejected', reason: 'workspaceMode' }, feedback: 'newSession.actionDefault.workspaceMode' },
        { refusal: { v: 1, status: 'rejected', reason: 'target' }, feedback: 'newSession.actionDefault.failed' },
    ])('shows the $refusal.status save refusal and permits retry without losing the task', async ({ refusal, feedback }) => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Keep this task', actionDefault }, scope,
            isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        const execute = vi.fn().mockResolvedValueOnce(refusal).mockResolvedValueOnce({ v: 1, status: 'applied' });
        const getCurrentDraft = () => {
            const draft = readNewSessionDraftFromRepository({ scope, draftId });
            if (!draft) throw new Error('Expected the seeded draft');
            return draft;
        };
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={execute}
            getCurrentDraft={getCurrentDraft} onProfileSaved={() => undefined} />);
        await pressSave(screen);
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe(feedback);
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Keep this task');
        await pressSave(screen);
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.saved');
        await screen.unmount();
    });

    it.each([
        { code: 'plugin_action_input_schema_invalid', feedback: 'common.requestFailed', outer: false },
        { code: 'plugin_action_unavailable', feedback: 'ui.pluginUi.actionUnavailable', outer: false },
        { code: 'approval_required', feedback: 'newSession.actionDefault.failed', outer: true },
        { code: 'approval_canceled', feedback: 'newSession.actionDefault.failed', outer: true },
        { code: 'plugin_action_current_intent_rejected', feedback: 'newSession.actionDefault.failed', outer: false },
        { code: 'unrecognized_action_failure', feedback: 'newSession.actionDefault.failed', outer: true },
    ])('presents thrown $code without losing the task and allows another save', async ({ code, feedback, outer }) => {
        const { NewSessionActionDefaults } = await import('./NewSessionActionDefaults');
        seedAndOpenNewSession({ seed: { prompt: 'Keep this task', actionDefault }, scope,
            isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => undefined });
        // Action execution is the external effect boundary; the shared presenter stays real.
        const execute = vi.fn().mockImplementationOnce(async () => {
            // The mounted executeValue owner throws every outer refusal before the leaf sees a value.
            if (outer) requireActionSuccess({ ok: false, errorCode: code, error: code });
            throw new PluginError({ code });
        }).mockResolvedValueOnce({ v: 1, status: 'applied' });
        const getCurrentDraft = () => {
            const draft = readNewSessionDraftFromRepository({ scope, draftId });
            if (!draft) throw new Error('Expected the seeded draft');
            return draft;
        };
        const screen = await renderScreen(<NewSessionActionDefaults scope={scope} draftId={draftId} execute={execute}
            getCurrentDraft={getCurrentDraft} onProfileSaved={() => undefined} />);
        await pressSave(screen);
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe(feedback);
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Keep this task');
        await pressSave(screen);
        expect(screen.findByTestId('new-session-action-default-feedback')?.props.children).toBe('newSession.actionDefault.saved');
        await screen.unmount();
    });
});
