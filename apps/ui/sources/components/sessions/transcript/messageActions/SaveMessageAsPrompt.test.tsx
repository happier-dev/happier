import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

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
    const catalog = createPromptLibraryCatalogBoundary({ revision: 4, settingsVersion: 1 });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    harness.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    for (const path of [PROMPT_LIBRARY_ROWS_ROUTE_V1, ...PromptLibraryCatalogKeyV1Schema.options.map(key => `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`)]) {
        harness.answer(serverId, path, { select: async input => {
            const response = await catalog.handle(path, input === null ? undefined
                : { method: 'POST', body: JSON.stringify(input) });
            return response ? { status: response.status, body: await response.json() } : undefined;
        } });
    }
    await harness.selectHomes([serverId]);
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await switchConnectionToActiveServer();
    const scope = { serverId, accountId: 'prompt-owner' };
    act(() => storage.setState({ settingsScope: scope, profileScope: scope, settingsVersion: 1 }));
    const saved: string[] = [];
    let closed = false;
    const screen = await renderScreen(<SaveMessagePromptForm messageId="u1" serverId={serverId}
        text={'  First line  \n\nKeep these spaces.  '}
        onClose={() => { closed = true; }} onSaved={(id) => saved.push(id)} />);
    const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    await waitForHomeGovernance(() => expect(getPromptLibraryCatalogValue(scope, 'invocations')).toMatchObject({ status: 'ready', stale: false }));
    return { screen, serverId, saved, catalog, isClosed: () => closed };
}

describe('Save a committed message through the prompt library and Account writer', () => {
    it('admits one Save across the name, shortcut and button while the Account boundary is pending', async () => {
        const { screen, serverId, saved, catalog } = await mount();
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
        expect(catalog.read('invocations').value).toMatchObject({ entries: [expect.objectContaining({ token: '/release-notes' })] });
        expect(catalog.requests.filter(request => request.key === 'invocations')).toEqual([{ key: 'invocations', expectedRevision: 4 }]);
        expect(harness.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
        expect(storage.getState().settingsVersion).toBe(1);
        expect(disabledWhilePending).toBe(true);
    });

    it('does not write on open or Cancel', async () => {
        const { screen, serverId, isClosed, saved, catalog } = await mount();
        expect(screen.findByTestId('save-message-prompt-name')?.props.value).toBe('First line');
        expect(screen.findByTestId('save-message-prompt-shortcut')).toBeNull();
        await screen.pressByTestIdAsync('save-message-prompt-cancel');
        expect(isClosed()).toBe(true);
        expect(saved).toEqual([]);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(catalog.read('invocations').value).toMatchObject({ entries: [] });
        expect(catalog.requests).toEqual([]);
    });

    it('creates one favourite with verbatim text and an optional validated shortcut', async () => {
        const { screen, serverId, saved, catalog } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-shortcut-toggle');
        await act(async () => screen.changeTextByTestId('save-message-prompt-shortcut', 'release-notes'));
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toHaveLength(1);
        const artifact = storage.getState().artifacts[saved[0]];
        expect(artifact.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'First line', favorite: true });
        if (typeof artifact.body !== 'string') throw new Error('Expected the saved prompt body to be text');
        expect(JSON.parse(artifact.body).markdown).toBe('  First line  \n\nKeep these spaces.  ');
        expect(catalog.read('invocations').value).toMatchObject({ entries: [
            expect.objectContaining({ token: '/release-notes', target: { kind: 'doc', artifactId: saved[0], serverId }, availableIn: 'global' }),
        ] });
        expect(catalog.requests.filter(request => request.key === 'invocations')).toEqual([{ key: 'invocations', expectedRevision: 4 }]);
        expect(harness.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
        expect(storage.getState().settingsVersion).toBe(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
    });

    it('refuses a reserved shortcut before creating an artifact', async () => {
        const { screen, serverId, saved, catalog } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-shortcut-toggle');
        await act(async () => screen.changeTextByTestId('save-message-prompt-shortcut', '/clear'));
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toEqual([]);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(catalog.requests).toEqual([]);
        expect(screen.getTextContent()).toContain('promptLibrary.templateTokenReserved');
    });

    it('saves with favourite off and no shortcut without writing invocations', async () => {
        const { screen, serverId, saved, catalog } = await mount();
        await screen.pressByTestIdAsync('save-message-prompt-favorite');
        await screen.pressByTestIdAsync('save-message-prompt-save');
        expect(saved).toHaveLength(1);
        expect(storage.getState().artifacts[saved[0]].header).toMatchObject({ favorite: false });
        expect(catalog.read('invocations').value).toMatchObject({ entries: [] });
        expect(catalog.requests.filter(request => request.key === 'invocations')).toEqual([]);
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
