import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(() => standardCleanup());

const { MachineSecurityGradeSummary } =
  await import('./MachineSecurityGradeSummary');
const { t } = await import('@/text');

const updates = {
  status: 'unknown',
} as unknown as MachineSecurityInspectResultV1['updates'];

const failing = (): MachineSecurityInspectResultV1 => ({
  grade: { kind: 'graded', band: 'C' },
  rows: [
    {
      check: 'osUpdates',
      state: 'fail',
      evidence: { pendingSecurity: 3, pendingAll: 11 },
      repair: {
        actionId: 'machines.setup.plan',
        target: { machineId: 'shop-prod' },
        inputHints: { scope: 'security' },
      },
    },
    {
      check: 'rebootRequired',
      state: 'pass',
      evidence: { rebootNeeded: false },
    },
    { check: 'firewall', state: 'unread', reason: 'needs_admin_to_check' },
    { check: 'isolation', state: 'inapplicable' },
  ],
  updates,
});

async function render(
  view: React.ComponentProps<typeof MachineSecurityGradeSummary>['view'],
  canFix = true,
) {
  const onFix = vi.fn();
  const screen = await renderScreen(
    <MachineSecurityGradeSummary
      view={view}
      machineName="shop-prod"
      fix={{ onFix, busy: false, canFix }}
    />,
  );
  return { screen, onFix };
}

describe('Machine Security grade summary', () => {
  it('places each row by the projection’s own state and opens the row’s repair, never deciding pass or fail itself', async () => {
    const { screen, onFix } = await render({
      kind: 'ready',
      result: failing(),
    });
    const inSection = (section: string, check: string) =>
      screen
        .findAll(
          (node) => node.props?.testID === `machine-security-grade-${section}`,
        )
        .some(
          (group) =>
            group.findAll(
              (node) =>
                node.props?.testID === `machine-security-grade-row-${check}`,
            ).length > 0,
        );
    expect(inSection('fail', 'osUpdates')).toBe(true);
    expect(inSection('pass', 'rebootRequired')).toBe(true);
    expect(inSection('unread', 'firewall')).toBe(true);
    // An inapplicable check is not a row and not a segment.
    expect(
      screen.findAll(
        (node) => node.props?.testID === 'machine-security-grade-row-isolation',
      ),
    ).toHaveLength(0);
    // The grade is the projection's letter; the unread check says why it was not read.
    expect(
      screen.findByTestId('machine-security-grade.tile')?.props
        .accessibilityLabel,
    ).toBe(t('machineDetailPage.security.grade.gradeLabel', { band: 'C' }));
    expect(screen.getTextContent()).toContain(
      t('machineDetailPage.security.securityWaiting', { count: 3 }),
    );
    const fix = screen.findAll(
      (node) =>
        node.props?.testID === 'machine-security-grade-fix-osUpdates' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      fix.props.onPress();
    });
    expect(onFix).toHaveBeenCalledWith({
      actionId: 'machines.setup.plan',
      target: { machineId: 'shop-prod' },
      inputHints: { scope: 'security' },
    });
  });

  it('shows Incomplete with the projection’s range and no letter, and offers no repair without Manage', async () => {
    const { screen } = await render(
      {
        kind: 'ready',
        result: {
          ...failing(),
          grade: { kind: 'incomplete', lowerBand: 'C', upperBand: 'F' },
        },
      },
      false,
    );
    expect(
      screen.findByTestId('machine-security-grade.tile')?.props
        .accessibilityLabel,
    ).toBe(
      t('machineDetailPage.security.grade.gradeRangeLabel', {
        lower: 'C',
        upper: 'F',
      }),
    );
    expect(screen.getTextContent()).toContain(
      t('machineDetailPage.security.grade.incomplete'),
    );
    expect(
      screen.findAll(
        (node) => node.props?.testID === 'machine-security-grade-fix-osUpdates',
      ),
    ).toHaveLength(0);
  });

  it('grades nothing while the Machine is offline and keeps a failed read distinct with its Retry', async () => {
    const offline = await render({ kind: 'offline' });
    expect(
      offline.screen.findByTestId('machine-security-grade.tile')?.props
        .accessibilityLabel,
    ).toBe(t('machineDetailPage.security.grade.gradeUnknownLabel'));
    expect(
      offline.screen.findAll((node) =>
        String(node.props?.testID ?? '').startsWith(
          'machine-security-grade-row-',
        ),
      ),
    ).toHaveLength(0);
    await offline.screen.unmount();
    const onRetry = vi.fn();
    const failed = await render({
      kind: 'failed',
      message: 'unreachable',
      onRetry,
    });
    expect(
      failed.screen.findByTestId('machine-security-grade.failed'),
    ).toBeTruthy();
  });
});
