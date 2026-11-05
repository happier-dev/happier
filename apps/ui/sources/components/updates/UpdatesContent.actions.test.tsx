import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { UpdatesContentModel } from '@/updates/useUpdatesContentModel';

import { UpdatesContent } from './UpdatesContent';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const MODEL = {
    summary: { actionableCount: 2, manualCount: 0, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true },
    groups: [], checkedAt: null, uncheckedMachineCount: 0, sessionsRunningOn: new Set(),
    runItem: async () => {}, updateGroup: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {},
    batch: null, checking: false, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false,
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
