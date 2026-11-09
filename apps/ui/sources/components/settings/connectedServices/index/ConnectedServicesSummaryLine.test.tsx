import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

describe('ConnectedServicesSummaryLine', () => {
    it('reaches the pointer floor with the Refresh all hit area while the link keeps its drawn size', async () => {
        const { ConnectedServicesSummaryLine } = await import('./ConnectedServicesSummaryLine');
        const screen = await renderScreen(
            <ConnectedServicesSummaryLine accountCount={3} needsYouCount={0} asOf={null} onRefreshAll={() => {}} />,
        );
        const refresh = screen.findByTestId('connected-services-summary-refresh-all')!;
        await act(async () => (refresh.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 84, height: 18 } } }));
        const area = readHitArea(screen.findByTestId('connected-services-summary-refresh-all')!, { width: 84, height: 18 });
        expect(area.height).toBe(24);
        expect(area.drawn.height).toBe(18);
    });
});
