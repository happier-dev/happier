import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { UpdatesContentModel } from '@/updates/useUpdatesContentModel';

import { UpdatesContent } from './UpdatesContent';
import { NO_STORE_UPDATE_ROWS } from '@/components/store/updates/StoreUpdateRow';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const MODEL = {
    summary: { actionableCount: 2, manualCount: 0, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true },
    groups: [], checkedAt: null, uncheckedMachineCount: 0, sessionsRunningOn: new Set(),
    runItem: async () => {}, updateGroup: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {},
    batch: null, checking: false, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false,
    storeRows: NO_STORE_UPDATE_ROWS,
} as unknown as UpdatesContentModel;

function drawnHeights(screen: Awaited<ReturnType<typeof renderScreen>>): unknown[] {
    return screen.findByTestId('updates.updateAll')!
        .findAll((node) => typeof node.type === 'string')
        .map((node) => (flattenTestStyle(node.props.style) as { minHeight?: unknown }).minHeight)
        .filter((height) => typeof height === 'number');
}

describe('Update all', () => {
    // The action also stands outside a page header: a button that takes its size from the header must not
    // fall back to the hero size where no header scopes it.
    it('draws at the dense height in the popover', async () => {
        const screen = await renderScreen(<UpdatesContent model={MODEL} presentation="popover" />);
        expect(drawnHeights(screen)).toContain(HAPPIER_PAGE_METRICS.smallControlHeightPx);
    });
});

describe('a Machine\'s Store items (UPDATES-UNIFY-1113 group.storeItems)', () => {
    it('lists the Store update waiting on a Machine in that Machine\'s section, through the Store\'s own row', async () => {
        const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
        const { buildStoreUpdates, captureStoreUpdateBasis } = await import('@/components/store/updates/storeUpdatesModel');
        const detail = createDeploymentEnvironmentDetailV1();
        const row = { kind: 'app' as const, key: 'app:env', scope: { serverId: 'home', accountId: 'account' },
            native: { environment: detail.environment, title: detail.content.name, chip: null }, home: '/environment', projectKeys: null };
        const storeItems = buildStoreUpdates([row], [{ kind: 'app', key: detail.environment.id,
            upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }],
            { checkedAt: 20, failed: false, basis: captureStoreUpdateBasis([row]) }).sections.flatMap((section) => section.entries);
        const studio = { id: 'machine:studio', kind: 'machine' as const, machineName: 'Studio', machineId: 'studio', online: true,
            lastSeenAt: null, items: [], storeItems };
        const screen = await renderScreen(<UpdatesContent model={{ ...MODEL, groups: [studio] }} presentation="screen" />);
        expect(screen.findByTestId('updates.section.machine:studio')).not.toBeNull();
        expect(screen.findByTestId('updates.section.machine:studio.store.app:env')).not.toBeNull();
        // The row offers the item's own review; Update all never runs it.
        expect(screen.findByTestId('updates.section.machine:studio.store.app:env.review')).not.toBeNull();
    });
});
