import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alert = vi.hoisted(() => vi.fn());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});
installSettingsViewCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert } }).module,
});
vi.doUnmock('@/sync/domains/state/storage');
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();

beforeEach(async () => { await harness.reset(); clearActiveUnsavedChangesGuard(); alert.mockReset(); });
afterEach(async () => {
    standardCleanup(); clearActiveUnsavedChangesGuard();
    await (await import('@/sync/syncEngine')).syncSwitchServer(null);
});

it('edits personal names and replacement bytes inline through the real Account settings CAS', async () => {
    const accountId = 'personal-secret-owner';
    const serverId = await harness.addHome({ name: 'Personal Secrets Home', serverUrl: 'https://personal-secret-editor.test', accountId });
    await harness.selectHomes([serverId]);
    const secret = {
        id: 'personal-inline', name: 'Personal key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'original-personal-secret' }, createdAt: 1, updatedAt: 1,
    };
    let baseline: Record<string, unknown> = { secrets: [secret] };
    let version = 1;
    const path = '/v2/account/settings';
    harness.answer(serverId, `GET ${path}`, { select: () => ({ body: { content: { t: 'plain', v: baseline }, version } }) });
    harness.answer(serverId, `POST ${path}`, { select: (input) => {
        // This is the network boundary's canonical Account Settings v2 request.
        const request = input as { content: { t: 'plain'; v: Record<string, unknown> }; expectedVersion: number };
        baseline = request.content.v;
        version = request.expectedVersion + 1;
        return { body: { success: true, version } };
    } });
    const { syncRestore } = await import('@/sync/syncEngine');
    await act(async () => syncRestore({ token: createAccountTokenForTests(accountId) }));
    const { storage } = await import('@/sync/domains/state/storage');
    await vi.waitFor(() => expect(storage.getState().settings.secrets[0]?.name).toBe(secret.name));
    const { SecretsSettingsScreen } = await import('./SecretsSettingsScreen');
    const screen = await renderScreen(<SecretsSettingsScreen />);
    await screen.pressByTestIdAsync(`saved-secret:${secret.id}:header`);
    await screen.pressByTestIdAsync(`saved-secret:${secret.id}:rename`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${secret.id}:edit-input`, '  Personal renamed  '));
    expect(harness.requestsFor(path).filter((request) => request.input !== null)).toHaveLength(0);
    await screen.pressByTestIdAsync(`saved-secret:${secret.id}:edit-save`);
    expect(alert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(storage.getState().settings.secrets[0]?.name).toBe('Personal renamed'));
    await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secret.id}:edit-input`)).toBeNull());
    await screen.pressByTestIdAsync(`saved-secret:${secret.id}:replace`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${secret.id}:edit-input`, '  personal replacement\n'));
    await screen.pressByTestIdAsync(`saved-secret:${secret.id}:edit-save`);
    await vi.waitFor(() => expect(baseline.secrets).toEqual([expect.objectContaining({
        id: secret.id, name: 'Personal renamed',
        encryptedValue: { _isSecretValue: true, value: '  personal replacement\n' },
    })]));
    expect(storage.getState().settings.secrets[0]?.name).toBe('Personal renamed');
    expect(harness.requestsFor(path).filter((request) => request.input !== null)).toHaveLength(2);
    expect(alert).not.toHaveBeenCalled();
});
