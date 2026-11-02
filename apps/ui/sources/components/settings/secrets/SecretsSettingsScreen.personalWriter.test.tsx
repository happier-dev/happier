import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { settingsParse } from '@/sync/domains/settings/settings';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createSecretSettingsTestHarness } from './secretSettingsTestHarness';

const alert = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({ storage: 'real',
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { alert, confirm } }).module,
});
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;

beforeEach(() => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetTeamActionClientForTests();
    clearActiveUnsavedChangesGuard();
    alert.mockReset();
    confirm.mockReset();
    confirm.mockResolvedValue(true);
});
afterEach(async () => {
    standardCleanup();
    clearActiveUnsavedChangesGuard();
    resetSavedSecretCatalogEngineForTests();
    await home?.dispose();
    home = null;
});

it('renames and replaces an imported private resource directly, but confirms deletion once', async () => {
    const secret = { id: 'personal-inline', name: 'Personal key', kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'original-personal-secret' }, createdAt: 1, updatedAt: 1 };
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [secret],
        actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'] },
        }),
    }) });
    const ref = `happier:shared-secret:v1:${deriveSavedSecretImportResourceIdV1({ accountId: home.scope.accountId,
        source: { kind: 'personal-saved-secret', secretId: secret.id } })}`;
    const { SecretsSettingsScreen } = await import('./SecretsSettingsScreen');
    const screen = await renderScreen(<SecretsSettingsScreen />);
    await vi.waitFor(() => expect(home?.promotions).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:header`)).not.toBeNull());
    expect(home.persistedSettings.secrets).toEqual([]);
    const settingsWritesBeforeEdit = home.settingsWrites.length;
    confirm.mockClear();

    await screen.pressByTestIdAsync(`saved-secret:${ref}:header`);
    await screen.pressByTestIdAsync(`saved-secret:${ref}:rename`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${ref}:edit-input`, '  Personal renamed  '));
    expect(home.updates).toEqual([]);
    await screen.pressByTestIdAsync(`saved-secret:${ref}:edit-save`);
    expect(confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(home?.updates).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${ref}:edit-input`)).toBeNull());
    await screen.pressByTestIdAsync(`saved-secret:${ref}:rotate`);
    await act(async () => screen.changeTextByTestId(`saved-secret:${ref}:edit-input`, '  personal replacement\n'));
    await screen.pressByTestIdAsync(`saved-secret:${ref}:edit-save`);
    await vi.waitFor(() => expect(home?.updates).toHaveLength(2));
    const replacement = home.updates[1]!;
    const opened = openSavedSecretResourceStoredContentV1({ resourceId: replacement.resourceId, mode: 'plain', storedContent: replacement.storedContent });
    expect(opened).toMatchObject({ v: 1, name: 'Personal renamed', value: '  personal replacement\n' });
    expect(confirm).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(`saved-secret:${ref}:delete`);
    await vi.waitFor(() => expect(home?.deletes).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(home.persistedSettings.secrets).toEqual([]);
    expect(home.settingsWrites).toHaveLength(settingsWritesBeforeEdit);
    expect(alert).not.toHaveBeenCalled();
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
