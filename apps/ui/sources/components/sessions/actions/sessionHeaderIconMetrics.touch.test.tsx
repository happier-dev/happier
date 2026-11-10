import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

import { renderScreen } from '@/dev/testkit';

import {
  SESSION_HEADER_ACTION_SIZE_PX,
  useSessionHeaderActionMetrics,
  type SessionHeaderActionMetrics,
} from './sessionHeaderIconMetrics';

async function readMetrics(
  platform: 'ios' | 'android',
): Promise<SessionHeaderActionMetrics> {
  let metrics: SessionHeaderActionMetrics | null = null;
  function Probe() {
    metrics = useSessionHeaderActionMetrics();
    return null;
  }
  const screen = await renderScreen(
    <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
      <Probe />
    </HappierUiPlatformProvider>,
  );
  await screen.unmount();
  if (!metrics) throw new Error('metrics not read');
  return metrics;
}

describe('session header actions under a finger', () => {
  it.each([
    ['ios', 44],
    ['android', 48],
  ] as const)(
    'on %s draw the header glyph and stand one %d pt target apart, so neighbouring hit areas abut',
    async (platform, targetPx) => {
      const metrics = await readMetrics(platform);
      expect(metrics.glyphPx).toBe(24);
      expect(SESSION_HEADER_ACTION_SIZE_PX + metrics.gapPx).toBe(targetPx);
    },
  );
});
