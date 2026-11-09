import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// The primary pointer is read once per app load, so this lives in its own file and a finger is it before anything mounts.
vi.stubGlobal('navigator', { maxTouchPoints: 1 });
const { WorkflowsColumnActions } = await import('./WorkflowsColumnActions');

afterEach(() => vi.unstubAllGlobals());

it('keeps the band actions off the title block under the band: sideways flush, below only into the band padding', async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
  for (const testID of ['workflows-column:add', 'workflows-column:more']) {
    const area = await layoutHitArea(() => screen.findHostByTestId(testID), { width: 28, height: 28 });
    expect(area.insets).not.toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(area.insets.left).toBe(0);
    expect(area.insets.right).toBe(0);
    expect(area.insets.bottom).toBe(HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop);
    expect(area.insets.top).toBeGreaterThan(area.insets.bottom);
  }
});
