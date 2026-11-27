import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { useShellCornerNote } from './shellCorner';
import { WorkflowPanel } from './WorkflowPanel';

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

afterEach(() => standardCleanup());

const SUMMARY =
  'This Home cleans up provider usage history after 90 days, public share access logs after 90 days.';

function RetentionNote() {
  useShellCornerNote({ disclosure: { kind: 'summary', summary: SUMMARY } });
  return null;
}

function contains(
  container: ReactTestInstance | null,
  testID: string,
): boolean {
  return (
    (container?.findAll((node) => node.props.testID === testID).length ?? 0) > 0
  );
}

/** A Welcome pane of this size whose retention disclosure laid out at `noteHeight` (the layout engine is the boundary). */
async function welcomeWithRetention(
  variant: 'desktop' | 'mobile',
  size: { width: number; height: number },
  noteHeight: number,
) {
  const screen = await renderScreen(
    <WorkflowPanel
      variant={variant}
      isWelcomeStep
      transitionKey="welcome"
      footerAccessory={<View testID="updates-entry" />}
    >
      <RetentionNote />
    </WorkflowPanel>,
  );
  await act(async () => {
    screen
      .findHostByTestId('unauth-shell-workflow-pane')
      ?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
    screen
      .findHostByTestId('unauth-shell-welcome-trail')
      ?.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: size.width, height: 160 } },
      });
  });
  await act(async () => {
    screen
      .findHostByTestId('unauth-shell-retention')
      ?.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 360, height: noteHeight } },
      });
  });
  return screen;
}

describe('WorkflowPanel retention disclosure', () => {
  it('stands in the footer row beside Updates on a wide Welcome when it wraps to two lines', async () => {
    const screen = await welcomeWithRetention(
      'desktop',
      { width: 1224, height: 765 },
      52,
    );
    const row = screen.findHostByTestId('welcome-footer-links');
    expect(contains(row, 'welcome-retention')).toBe(true);
    expect(contains(row, 'updates-entry')).toBe(true);
  });

  it('stacks above the row when its copy needs more than two lines there', async () => {
    const screen = await welcomeWithRetention(
      'desktop',
      { width: 1224, height: 765 },
      88,
    );
    expect(
      contains(
        screen.findHostByTestId('welcome-footer-links'),
        'welcome-retention',
      ),
    ).toBe(false);
    expect(screen.findHostByTestId('welcome-retention')).not.toBeNull();
  });

  it('keeps the compact placement on a phone', async () => {
    const screen = await welcomeWithRetention(
      'mobile',
      { width: 390, height: 844 },
      52,
    );
    expect(
      contains(
        screen.findHostByTestId('welcome-footer-links'),
        'welcome-retention',
      ),
    ).toBe(false);
    expect(screen.findHostByTestId('welcome-retention')).not.toBeNull();
  });

  it('draws the disclosure on the shared glass material, its words inside it', async () => {
    const screen = await welcomeWithRetention(
      'desktop',
      { width: 1224, height: 765 },
      52,
    );
    const glass = screen.findAllByType(GlassSurface);
    expect(
      glass.some((surface) => contains(surface, 'welcome-retention')),
    ).toBe(true);
  });
});
