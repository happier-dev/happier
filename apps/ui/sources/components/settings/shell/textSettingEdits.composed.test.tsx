import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { MachineTerminalSettingsSection } = await import('@/components/machines/terminal/MachineTerminalSettingsSection');
const { TranscriptSettingsView } = await import('@/components/settings/session/TranscriptSettingsView');
const { SourceControlSettingsView } = await import('@/components/settings/sourceControl/SourceControlSettingsView');
const { SessionRuntimeSettingsView } = await import('@/components/settings/session/SessionRuntimeSettingsView');
const { SessionProviderLimitsSettingsView } = await import('@/components/settings/session/SessionProviderLimitsSettingsView');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { Modal } = await import('@/modal');

const recovery = { v: 1, mode: 'ask', promptMode: 'standard', resumePromptMode: 'custom', customResumePrompt: 'saved' } as const;
const recoveryFeatures = createRootLayoutFeaturesResponse({ features: { sessions: { usageLimitRecovery: { enabled: true } } } });
const resumeInputId = 'settings-session-usageLimitRecovery-customResumePrompt-input';

// Only the external HTTP response is held/refused; the mounted field, Action, CAS and store run for real.
function controlSettingsResponse() {
    const state = storage.getState();
    const request = account.home.requests.find(request => request.serverId === account.serverId);
    if (!request) throw new Error('Missing mounted Account Home');
    const http = createAccountSettingsHttpBoundary({ serverUrl: request.serverUrl, initialAccounts: [{
        accountId: state.settingsScope!.accountId,
        snapshot: { version: state.settingsVersion!, content: { t: 'plain', v: state.settings } },
    }] });
    const release = createDeferred<void>();
    let refused = false;
    account.home.answer(account.serverId, '/v2/account/settings', { select: async (_input, request) => {
        if (request.init?.method === 'POST') {
            if (refused) return { status: 400, body: { error: 'invalid-params' } };
            await release.promise;
        }
        const response = http.handle(request.url, request.init);
        if (!response) throw new Error('Missing Settings response');
        return { status: response.status, body: await response.json() };
    } });
    return { release: () => release.resolve(), refuse: () => { refused = true; }, accept: () => { refused = false; release.resolve(); } };
}

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Account text-edit gestures through canonical Actions', () => {
    it.each((['resume', 'accountDirectory', 'machineDirectory'] as const).flatMap(kind =>
        (['plain', 'e2ee'] as const).map(mode => ({ kind, mode }))))('$kind ($mode) acknowledges normalized text and follows a later remote update', async ({ kind, mode }) => {
        const machine = createMachineFixture();
        await account.restore({ waivedActions: ['settings.set'], machines: [machine], features: recoveryFeatures,
            ...(mode === 'e2ee' ? { e2eeSecret: new Uint8Array(32).fill(17) } : {}), settings: {
            sessionTerminalHost: 'tmux', sessionUseTmux: true, sessionTmuxIsolated: true, sessionTmuxTmpDir: '/tmp/work',
            sessionTmuxByMachineId: { [machine.id]: { useTmux: true, sessionName: 'work', isolated: true, tmpDir: '/tmp/work' } },
            usageLimitRecoverySettingsV1: recovery,
        } });
        const screen = await renderScreen(kind === 'resume' ? <SessionProviderLimitsSettingsView />
            : kind === 'accountDirectory' ? <SessionRuntimeSettingsView />
                : <MachineTerminalSettingsSection serverId={account.serverId} machineId={machine.id} tmuxAvailable />);
        const input = () => kind === 'machineDirectory'
            ? screen.findAllByType(FieldTextInput).find(node => node.props.accessibilityLabel === 'profiles.tmuxTempDir')!
            : screen.findByTestId(kind === 'resume' ? resumeInputId : 'settings-session-tmux-tmpdir')!;
        const read = () => kind === 'resume' ? storage.getState().settings.usageLimitRecoverySettingsV1.customResumePrompt
            : kind === 'accountDirectory' ? storage.getState().settings.sessionTmuxTmpDir
                : storage.getState().settings.sessionTmuxByMachineId[machine.id]?.tmpDir;
        const posts = () => account.home.requests.filter(request => request.path === '/v2/account/settings' && request.input !== null).length;
        const before = posts();
        await act(async () => { input().props.onChangeText(kind === 'resume' ? '  next  ' : '   '); });
        expect(posts()).toBe(before);
        await act(async () => { const props = input().props; props.onSubmitEditing(); props.onBlur(); });
        await vi.waitFor(() => expect(read()).toBe(kind === 'resume' ? 'next' : null));
        await vi.waitFor(() => expect(input().props.value).toBe(kind === 'resume' ? 'next' : ''));
        expect(posts()).toBe(before + 1);
        await act(async () => { input().props.onBlur(); });
        expect(posts()).toBe(before + 1);
        if (kind !== 'resume') {
            await act(async () => { input().props.onChangeText('  /tmp/kept  '); });
            await act(async () => { input().props.onBlur(); });
            await vi.waitFor(() => expect(read()).toBe('  /tmp/kept  '));
            expect(input().props.value).toBe('  /tmp/kept  ');
        }
        // A constructed, newer server revision enters the canonical Settings ingress and reaches the mounted field.
        await act(async () => { const state = storage.getState(); const settings = state.settings;
            state.applySettingsForScope(state.settingsScope!, { ...settings,
            ...(kind === 'resume' ? { usageLimitRecoverySettingsV1: { ...settings.usageLimitRecoverySettingsV1, customResumePrompt: 'remote' } }
                : kind === 'accountDirectory' ? { sessionTmuxTmpDir: '/remote' }
                    : { sessionTmuxByMachineId: { ...settings.sessionTmuxByMachineId,
                        [machine.id]: { ...settings.sessionTmuxByMachineId[machine.id]!, tmpDir: '/remote' } } }),
        }, state.settingsVersion! + 1); });
        expect(input().props.value).toBe(kind === 'resume' ? 'remote' : '/remote');
    });

    it('keeps an edit made after submission when the earlier Settings Action is acknowledged', async () => {
        await account.restore({ waivedActions: ['settings.set'], features: recoveryFeatures, settings: { usageLimitRecoverySettingsV1: recovery } });
        const response = controlSettingsResponse();
        const screen = await renderScreen(<SessionProviderLimitsSettingsView />);
        const input = () => screen.findByTestId(resumeInputId)!;
        try {
            await act(async () => { input().props.onChangeText('  next  '); });
            await act(async () => { input().props.onSubmitEditing(); });
            await vi.waitFor(() => expect(account.home.requests.some(request => request.path === '/v2/account/settings' && request.input !== null)).toBe(true));
            await act(async () => { input().props.onChangeText('newer edit'); response.release(); });
            await vi.waitFor(() => expect(storage.getState().settings.usageLimitRecoverySettingsV1.customResumePrompt).toBe('next'));
            expect(input().props.value).toBe('newer edit');
            await act(async () => { input().props.onBlur(); });
            await vi.waitFor(() => expect(storage.getState().settings.usageLimitRecoverySettingsV1.customResumePrompt).toBe('newer edit'));
        } finally { response.release(); }
    });

    it('retains a refused Settings Action draft for an explicit retry', async () => {
        await account.restore({ waivedActions: ['settings.set'], features: recoveryFeatures, settings: { usageLimitRecoverySettingsV1: recovery } });
        const response = controlSettingsResponse();
        response.refuse();
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderScreen(<SessionProviderLimitsSettingsView />);
        const input = () => screen.findByTestId(resumeInputId)!;
        try {
            await act(async () => { input().props.onChangeText('retry me'); });
            await act(async () => { input().props.onSubmitEditing(); input().props.onBlur(); });
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(storage.getState().settings.usageLimitRecoverySettingsV1.customResumePrompt).toBe('saved');
            expect(input().props.value).toBe('retry me');
            response.accept();
            await act(async () => { input().props.onSubmitEditing(); });
            await vi.waitFor(() => expect(storage.getState().settings.usageLimitRecoverySettingsV1.customResumePrompt).toBe('retry me'));
        } finally { response.release(); }
    });

    it.each(['machineName', 'machineDirectory', 'transcript', 'instructions'] as const)('%s persists one completed edit and ignores unchanged blur', async kind => {
        const machine = createMachineFixture();
        await account.restore({ waivedActions: ['settings.set'], machines: [machine], settings: {
            sessionTerminalHost: 'tmux', sessionUseTmux: true, scmCommitMessageGeneratorEnabled: true,
            sessionTmuxByMachineId: { [machine.id]: { useTmux: true, sessionName: 'work', isolated: true, tmpDir: '/tmp/work' } },
        }, features: createRootLayoutFeaturesResponse({ features: { scm: { enabled: true, writeOperations: { enabled: true } } } }) });
        const screen = await renderScreen(kind.startsWith('machine')
            ? <MachineTerminalSettingsSection serverId={account.serverId} machineId={machine.id} tmuxAvailable />
            : kind === 'transcript' ? <TranscriptSettingsView /> : <SourceControlSettingsView />);
        const input = () => kind.startsWith('machine')
            ? screen.findAllByType(FieldTextInput).find(node => node.props.accessibilityLabel === (kind === 'machineName' ? 'profiles.tmuxSession' : 'profiles.tmuxTempDir'))!
            : screen.findByTestId(kind === 'transcript' ? 'settings-session-transcript-message-send-template-input' : 'settings.sourceControl.commitMessageInstructions')!;
        expect(input()).toBeTruthy();
        const read = () => kind === 'machineName' ? storage.getState().settings.sessionTmuxByMachineId[machine.id]?.sessionName
            : kind === 'machineDirectory' ? storage.getState().settings.sessionTmuxByMachineId[machine.id]?.tmpDir
                : kind === 'transcript' ? storage.getState().settings.transcriptMessageSendToSessionTemplate
                    : storage.getState().settings.scmCommitMessageGeneratorInstructions;
        const initial = read();
        const transitions: unknown[] = [];
        const stop = storage.subscribe(() => { const next = read(); if (next !== (transitions.length ? transitions.at(-1) : initial)) transitions.push(next); });
        // The shared boundary records parsed bodies, not HTTP methods; GET has a null input.
        const posts = () => account.home.requests.filter(request => request.path === '/v2/account/settings' && request.input !== null).length;
        const beforePosts = posts();
        try {
            await act(async () => { input().props.onBlur?.(); });
            expect(transitions).toEqual([]);
            expect(posts()).toBe(beforePosts);
            const edited = kind === 'transcript' || kind === 'instructions' ? '  abcdef \n' : 'abcdefghij';
            for (let length = 1; length <= edited.length; length++) await act(async () => { input().props.onChangeText(edited.slice(0, length)); });
            expect(transitions).toEqual([]);
            await act(async () => { const props = input().props; props.onSubmitEditing(); props.onBlur(); });
            await vi.waitFor(() => expect(read()).toBe(edited));
            await vi.waitFor(() => expect(posts()).toBe(beforePosts + 1));
            expect(transitions).toEqual([edited]);
        } finally { stop(); }
    });
});
