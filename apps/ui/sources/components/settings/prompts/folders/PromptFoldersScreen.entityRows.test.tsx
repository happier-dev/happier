import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installPromptLibrarySettingsCommonModuleMocks } from '../promptLibrarySettingsTestHelpers';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

installDisconnectedServerSocketBoundary();
const prompt = vi.hoisted(() => vi.fn(async (): Promise<string | null> => 'New folder'));
const alert = vi.hoisted(() => vi.fn());
installPromptLibrarySettingsCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { prompt, alert } }).module;
    },
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { PromptFoldersScreen } = await import('./PromptFoldersScreen');

describe('folder editor catalog mutation', () => {
    it.each(['updated', 'conflict'] as const)('writes a named folder at the reviewed row revision and reports a refusal: %s', async (outcome) => {
        await loadSyncSingletonForTests();
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        let settingsWrites = 0;
        let revision = 4;
        const tombstones = PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'folders').map(key => ({ key, revision: 1 }));
        let value: Extract<PromptLibraryRecordV1, { key: 'folders' }>['value'] = { v: 1, folders: [{ id: 'folder-old', name: 'Original', parentId: null }] };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-folder-row.example.test', accountId: 'alice',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                    v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1',
                } } });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') {
                    if (init?.method === 'POST') settingsWrites += 1;
                    return Response.json({ content: { t: 'plain', v: {} }, version: 7 });
                }
                if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
                    rows: [{ key: 'folders', revision, content: { t: 'plain', v: { key: 'folders', value } } },
                        ...tombstones.map(row => ({ ...row, content: null }))] });
                if (path === '/v1/account/entity-rows/prompt-library/folders' && init?.method === 'POST') {
                    const input = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input.expectedRevision).toBe(4);
                    if (input.content?.t !== 'plain' || input.content.v.key !== 'folders') throw new Error('Unexpected folder row');
                    if (outcome === 'conflict') return Response.json({ status: 'conflict', revision: 5 });
                    value = input.content.v.value;
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return new Response(null, { status: 404 });
            } });
        onTestFinished(connection.dispose);
        const scope = { serverId: connection.home.id, accountId: 'alice' };
        storage.setState({ settings: settingsDefaults, settingsScope: scope, settingsVersion: 7, profileScope: scope });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision, record: { key: 'folders', value } }],
            tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const screen = await renderScreen(<PromptFoldersScreen />);
        await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', stale: false }));
        alert.mockClear();
        await screen.pressByTestIdAsync('promptFolders.add');
        await act(async () => { screen.findByTestId('promptFolders:edit:name')!.props.onChangeText('New folder'); });
        await screen.pressByTestIdAsync('promptFolders:edit:save');
        if (outcome === 'updated') {
            await vi.waitFor(() => expect(value.folders.map(folder => folder.name)).toEqual(['Original', 'New folder']));
            expect(alert).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(() => expect(screen.findByTestId('promptFolders:edit:name.error')).toBeTruthy());
            expect(screen.findByTestId('promptFolders:edit:name')!.props.value).toBe('New folder');
            expect(value.folders.map(folder => folder.name)).toEqual(['Original']);
        }
        expect(alert).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
        expect(settingsWrites).toBe(0);
        expect(storage.getState().settingsVersion).toBe(7);
    });
});
