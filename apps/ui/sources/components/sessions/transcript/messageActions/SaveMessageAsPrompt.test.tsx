import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
vi.doUnmock('@/sync/domains/state/storage');
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { SaveMessagePromptForm } = await import('./SaveMessageAsPrompt');

beforeEach(async () => { await harness.reset(); });
afterEach(async () => {
    standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
});

async function mount() {
    const serverId = await harness.addHome({ name: 'Prompt Home', serverUrl: 'https://prompt-save.test', accountId: 'prompt-owner' });
    await harness.selectHomes([serverId]);
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await switchConnectionToActiveServer();
    const scope = { serverId, accountId: 'prompt-owner' };
    act(() => storage.setState({ settingsScope: scope, profileScope: scope, settingsVersion: 1,
        settings: { ...storage.getState().settings, promptInvocationsV1: { v: 1, entries: [] } } }));
    const saved: string[] = [];
    let closed = false;
    const screen = await renderScreen(<SaveMessagePromptForm messageId="u1" serverId={serverId}
        text={'  First line  \n\nKeep these spaces.  '}
        onClose={() => { closed = true; }} onSaved={(id) => saved.push(id)} />);
    return { screen, serverId, saved, isClosed: () => closed };
}

describe('Save a committed message through the prompt library and Account writer', () => {
    it('admits one Save across the name, shortcut and button while the Account boundary is pending', async () => {
        const { screen, serverId, saved } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-shortcut-toggle');
        await act(async () => screen.changeTextByTestId('save-message-prompt-shortcut', 'release-notes'));
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        harness.answer(serverId, '/v1/account/encryption', { body: { mode: 'plain', updatedAt: 0 }, respondAfter: pending });
        const name = screen.findByTestId('save-message-prompt-name')!;
        const shortcut = screen.findByTestId('save-message-prompt-shortcut')!;
        const saves: Promise<void>[] = [];
        await act(async () => {
            saves.push(name.props.onSubmitEditing(), shortcut.props.onSubmitEditing());
        });
        const button = screen.findByTestId('save-message-prompt-save')!;
        const disabledWhilePending = button.props.disabled;
        await act(async () => { saves.push((button.props.action ?? button.props.onPress)()); });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        await act(async () => { release(); await Promise.all(saves); });
        expect(saved).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        expect(storage.getState().settings.promptInvocationsV1.entries).toHaveLength(1);
        expect(disabledWhilePending).toBe(true);
    });

    it('does not write on open or Cancel', async () => {
        const { screen, serverId, isClosed, saved } = await mount();
        expect(screen.findByTestId('save-message-prompt-name')?.props.value).toBe('First line');
        expect(screen.findByTestId('save-message-prompt-shortcut')).toBeNull();
        await screen.pressByTestIdAsync('save-message-prompt-cancel');
        expect(isClosed()).toBe(true);
        expect(saved).toEqual([]);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(storage.getState().settings.promptInvocationsV1.entries).toEqual([]);
    });

    it('creates one favourite with verbatim text and an optional validated shortcut', async () => {
        const { screen, serverId, saved } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-shortcut-toggle');
        await act(async () => screen.changeTextByTestId('save-message-prompt-shortcut', 'release-notes'));
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toHaveLength(1);
        const artifact = storage.getState().artifacts[saved[0]];
        expect(artifact.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'First line', favorite: true });
        if (typeof artifact.body !== 'string') throw new Error('Expected the saved prompt body to be text');
        expect(JSON.parse(artifact.body).markdown).toBe('  First line  \n\nKeep these spaces.  ');
        expect(storage.getState().settings.promptInvocationsV1.entries).toEqual([
            expect.objectContaining({ token: '/release-notes', target: { kind: 'doc', artifactId: saved[0] }, availableIn: 'global' }),
        ]);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
    });

    it('refuses a reserved shortcut before creating an artifact', async () => {
        const { screen, serverId, saved } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-shortcut-toggle');
        await act(async () => screen.changeTextByTestId('save-message-prompt-shortcut', '/clear'));
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toEqual([]);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(screen.getTextContent()).toContain('promptLibrary.templateTokenReserved');
    });

    it('saves with favourite off and no shortcut without writing invocations', async () => {
        const { screen, serverId, saved } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-favorite');
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toHaveLength(1);
        expect(storage.getState().artifacts[saved[0]].header).toMatchObject({ favorite: false });
        expect(storage.getState().settings.promptInvocationsV1.entries).toEqual([]);
    });

    it('does not write into a newly selected Account from an old form', async () => {
        const { screen, serverId, saved } = await mount();
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://prompt-other.test', accountId: 'other-owner' });
        await harness.selectHomes([other]);
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await act(async () => { await switchConnectionToActiveServer(); });
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toEqual([]);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(harness.artifacts(other).list()).toHaveLength(0);
        expect(screen.getTextContent()).toContain('committedMessageActions.wrongAccount');
    });
});
