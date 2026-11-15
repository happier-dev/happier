import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
afterEach(standardCleanup);

const { MachinePresenceCounts } = await import('./MachinePresenceCounts');
const { StatusDot } = await import('@/components/ui/status/StatusDot');

describe('Machine presence (UI refinements 2026-11-15 08:57Z: Machine state through the one inline Status)', () => {
  it('says online and offline through the shared inline Status in their tones, with no hand-drawn dot, and leaves out an empty side', async () => {
    const screen = await renderScreen(
      <MachinePresenceCounts
        testID="presence"
        counts={{ online: 2, offline: 1 } as never}
      />,
    );
    const marks = screen.root.findAll(
      (node) =>
        node.props.presentation === 'inline' &&
        node.props.label !== undefined &&
        node.props.tone !== undefined &&
        typeof node.type !== 'string',
    );
    expect([...new Set(marks.map((node) => node.props.tone))]).toEqual([
      'success',
      'muted',
    ]);
    expect(screen.root.findAllByType(StatusDot)).toEqual([]);
    const onlineOnly = await renderScreen(
      <MachinePresenceCounts counts={{ online: 3, offline: 0 } as never} />,
    );
    expect([
      ...new Set(
        onlineOnly.root
          .findAll(
            (node) =>
              node.props.presentation === 'inline' &&
              node.props.tone !== undefined,
          )
          .map((node) => node.props.tone),
      ),
    ]).toEqual(['success']);
  });
});
