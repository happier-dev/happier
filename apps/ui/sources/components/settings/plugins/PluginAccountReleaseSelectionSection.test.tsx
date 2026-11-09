import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { PluginAccountReleaseSelectionSection } from './PluginAccountReleaseSelectionSection';

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

// The row component itself: the outermost instance below the section that
// carries the testID, so the assertions read the props this section hands the
// real Item rather than the inner pressable the Item renders.
function rowByTestId(screen: RenderedScreen, testID: string) {
    return screen.findAllByTestId(testID)
        .find((node) => node.type !== PluginAccountReleaseSelectionSection) ?? null;
}

function createHostedReader() {
    const pluginId = 'example.tasks';
    return createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot: {
            availabilityCursor: 4, materializations: [], snapshots: [],
            intentReads: [{ pluginId, response: {
                availabilityCursor: 4,
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId, desiredVersion: '2.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
                release: {
                    ref: { pluginId, version: '2.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '2.0.0', displayName: 'Tasks', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} }),
                    collectionContracts: [],
                    uiSlots: [{ contributionId: 'ui', artifactId: 'ui', tier: 'hostedWeb', platform: 'web', artifactDigest: `sha256:${'b'.repeat(64)}`, hostUiApiRange: '^1.0.0' }],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] },
                }, uiArtifacts: [], packageAssets: [],
            } }],
        },
    });
}

const select = vi.hoisted(() => vi.fn(async () => Object.freeze({
    kind: 'selected' as const,
    intent: {
        pluginId: 'example.tasks',
        desiredVersion: '2.0.0',
        enabled: true,
        offlineUiHosting: 'disabled' as const,
        writableCollections: [],
        revision: 'intent-1',
    },
})));
const retire = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => true));
const readHostedArtifactStatus = vi.hoisted(() => vi.fn(() => 'unavailable' as 'unavailable' | 'hosted'));
const setHostedArtifactsEnabled = vi.hoisted(() => vi.fn(async () => ({ kind: 'updated' as const })));
const disableAndRemoveHostedArtifacts = vi.hoisted(() => vi.fn(async () => ({ kind: 'updated' as const })));
const clearHostedArtifactCache = vi.hoisted(() => vi.fn(async () => ({ kind: 'updated' as const })));
const createController = vi.hoisted(() => vi.fn(() => ({
    select,
    readHostedArtifactStatus,
    setHostedArtifactsEnabled,
    disableAndRemoveHostedArtifacts,
    clearHostedArtifactCache,
    retire,
    isPending: () => false,
})));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', () => ({
    Modal: { alert, confirm },
}));

vi.mock('./pluginAccountReleaseSelectionController', () => ({
    createPluginAccountReleaseSelectionController: createController,
}));

afterEach(() => {
    standardCleanup();
    select.mockClear();
    retire.mockClear();
    alert.mockClear();
    confirm.mockClear();
    createController.mockClear();
    readHostedArtifactStatus.mockReset();
    readHostedArtifactStatus.mockReturnValue('unavailable');
    setHostedArtifactsEnabled.mockClear();
    disableAndRemoveHostedArtifacts.mockClear();
    clearHostedArtifactCache.mockClear();
});

describe('PluginAccountReleaseSelectionSection', () => {
    it('keeps the Account-only action available without daemon execution or machine install authority', async () => {
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version="2.0.0"
                reader={null}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="settings.plugins.detail.example.tasks.accountRelease"
            />,
        );

        const row = rowByTestId(screen, 'settings.plugins.detail.example.tasks.accountRelease');
        expect(row?.props.title).toBe('settingsPlugins.accountReleaseSelection.entryTitle');
        expect(row?.props.destructive).not.toBe(true);
        expect(row?.props.disabled).toBe(false);
        await act(async () => {
            row?.props.onPress();
            await Promise.resolve();
        });

        expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            pluginId: 'example.tasks',
            version: '2.0.0',
            reader: null,
            projection: null,
            daemon: { serverId: null, serverIdentityId: null, machineId: null },
        }));
        // The selected Account release is already the visible state owner; a
        // second success modal adds no information and interrupts focus.
        expect(alert).not.toHaveBeenCalled();
    });

    it.each([
        [
            Object.freeze({ kind: 'conflict' as const, code: 'intent_revision_conflict' as const }),
            'settingsPlugins.accountReleaseSelection.conflictTitle',
            'settingsPlugins.accountReleaseSelection.conflictBody',
        ],
        [
            Object.freeze({ kind: 'unavailable' as const, code: 'target_release_unavailable' as const }),
            'settingsPlugins.accountReleaseSelection.unavailableTitle',
            'settingsPlugins.accountReleaseSelection.unavailableBody',
        ],
    ])('presents %s as its typed release-selection result', async (result, title, body) => {
        select.mockResolvedValueOnce(result as never);
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version="2.0.0"
                reader={null}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="plugin.release"
            />,
        );

        await act(async () => {
            rowByTestId(screen, 'plugin.release')?.props.onPress();
            await Promise.resolve();
        });

        expect(alert).toHaveBeenCalledWith(title, body);
    });

    it('shows current hosted status and exposes removal plus exact local cache clear actions', async () => {
        readHostedArtifactStatus.mockReturnValue('hosted');
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const reader = createHostedReader();
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version="2.0.0"
                reader={reader}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="plugin.release"
            />,
        );

        expect(rowByTestId(screen, 'plugin.release.hosting')?.props.subtitle).toBe(
            'settingsPlugins.accountReleaseSelection.hostedStatusReady',
        );
        await act(async () => {
            rowByTestId(screen, 'plugin.release.clearCache')?.props.onPress();
            await Promise.resolve();
        });
        expect(clearHostedArtifactCache).toHaveBeenCalledWith({ pluginId: 'example.tasks', reader });
        await act(async () => {
            rowByTestId(screen, 'plugin.release.removeHosted')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(disableAndRemoveHostedArtifacts).toHaveBeenCalledWith({ pluginId: 'example.tasks', reader });
        expect(confirm).not.toHaveBeenCalled();
    });


    it.each([
        ['conflict', 'settingsPlugins.accountReleaseSelection.conflictTitle', 'settingsPlugins.accountReleaseSelection.conflictBody'],
        ['unavailable', 'settingsPlugins.accountReleaseSelection.unavailableTitle', 'settingsPlugins.accountReleaseSelection.unavailableBody'],
    ] as const)('presents a hosted-artifact %s with its typed recovery copy', async (kind, title, body) => {
        readHostedArtifactStatus.mockReturnValue('notOptedIn' as never);
        setHostedArtifactsEnabled.mockResolvedValueOnce({ kind } as never);
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const reader = createHostedReader();
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version="2.0.0"
                reader={reader}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="plugin.release"
            />,
        );

        await act(async () => {
            rowByTestId(screen, 'plugin.release.hosting')?.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(alert).toHaveBeenCalledWith(title, body);
    });

    it('keeps the Account hosting lifecycle reachable without a machine-selectable release version', async () => {
        readHostedArtifactStatus.mockReturnValue('hosted');
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const reader = createHostedReader();
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version={null}
                reader={reader}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="plugin.release"
            />,
        );

        // The Account-hosted archive outlives every machine installation, so
        // its status and removal must not depend on a current machine release.
        expect(rowByTestId(screen, 'plugin.release')).toBeNull();
        expect(rowByTestId(screen, 'plugin.release.hosting')?.props.subtitle).toBe(
            'settingsPlugins.accountReleaseSelection.hostedStatusReady',
        );
        expect(rowByTestId(screen, 'plugin.release.removeHosted')).not.toBeNull();
        await act(async () => {
            rowByTestId(screen, 'plugin.release.clearCache')?.props.onPress();
            await Promise.resolve();
        });
        expect(clearHostedArtifactCache).toHaveBeenCalledWith({ pluginId: 'example.tasks', reader });
        expect(select).not.toHaveBeenCalled();
    });

    it('renders nothing when neither a release selection nor Account hosting is current', async () => {
        const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
        const screen = await renderScreen(
            <PluginAccountReleaseSelectionSection
                pluginId="example.tasks"
                version={null}
                reader={null}
                projection={null}
                daemon={{ serverId: null, serverIdentityId: null, machineId: null }}
                testID="plugin.release"
            />,
        );

        expect(screen.tree.toJSON()).toBeNull();
    });
});
