import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { hitAreaOverlap, layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

import { LookChip } from '@/components/atmosphere/look/LookChip';
import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import {
  NewSessionComposerCloseButton,
  NewSessionComposerKeyboardDismissButton,
} from '@/components/sessions/new/components/NewSessionComposerCloseButton';
import { NewSessionComposerLookButton } from '@/components/sessions/new/components/NewSessionComposerLookButton';
import { instrumentStripStyles } from './instrumentStripStyles';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('the status row\'s host actions', () => {
  afterEach(async () => {
    await standardCleanup();
  });

  it('keeps the Look chip and the composer close apart: the row\'s gap holds both hit areas', async () => {
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <LookChip target={{ surface: 'new-session' }} testID="new-session-look" />
        <NewSessionComposerCloseButton onPress={() => {}} />
      </HappierUiPlatformProvider>,
    );
    const look = await layoutHitArea(
      () => screen.findHostByTestId('new-session-look'),
      { width: 28, height: 28 },
    );
    const close = await layoutHitArea(
      () => screen.findHostByTestId('new-session-composer-close'),
      { width: AGENT_INPUT_QUIET_ICON_SIZE_PX, height: AGENT_INPUT_QUIET_ICON_SIZE_PX },
    );
    const gap = Number(instrumentStripStyles.trailingActions.gap ?? 0);
    expect(hitAreaOverlap(look, close, { axis: 'horizontal', gap })).toBe(0);
  });

  it('keeps the composer\'s own status icons off the card they sit just above', async () => {
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <NewSessionComposerLookButton target={{ surface: 'new-session' }} testID="new-session-look" />
        <NewSessionComposerCloseButton onPress={() => {}} />
        <NewSessionComposerKeyboardDismissButton onPress={() => {}} />
      </HappierUiPlatformProvider>,
    );
    const size = { width: AGENT_INPUT_QUIET_ICON_SIZE_PX, height: AGENT_INPUT_QUIET_ICON_SIZE_PX };
    for (const id of ['new-session-look', 'new-session-composer-close', 'new-session-composer-dismiss-keyboard']) {
      const area = await layoutHitArea(() => screen.findHostByTestId(id), size);
      expect(area.insets.bottom, id).toBe(0);
      expect(area.insets.top, id).toBeGreaterThan(0);
    }
  });
});
