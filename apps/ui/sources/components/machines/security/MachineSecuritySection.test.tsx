import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import type {
  MachineSecurityControls,
  MachineUpdatesModel,
} from './MachineSecuritySection';

installMachinesSettingsCommonModuleMocks();

type Observation = NonNullable<MachineUpdatesModel['observation']>;

function model(
  observation: Observation | null,
  overrides: Partial<MachineUpdatesModel> = {},
): MachineUpdatesModel {
  return {
    observation,
    status: observation?.status ?? 'unknown',
    reason: observation?.reason ?? null,
    backend: observation?.backend ?? null,
    pendingSecurity: observation?.pendingSecurity ?? null,
    pendingAll: observation?.pendingAll ?? null,
    rebootNeeded: observation?.rebootNeeded ?? null,
    stale: false,
    refreshing: false,
    read: { kind: 'settled' },
    failure: null,
    approval: null,
    refresh: vi.fn(async () => {}),
    ...overrides,
  };
}

function controls(
  overrides: Partial<MachineSecurityControls> = {},
): MachineSecurityControls {
  return {
    review: { kind: 'idle' },
    onPrepare: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    reboot: { kind: 'idle' },
    canReboot: true,
    onReboot: vi.fn(),
    onDismissReboot: vi.fn(),
    onOpenApproval: vi.fn(),
    onOpenOperation: vi.fn(),
    ...overrides,
  };
}

async function render(
  updates: MachineUpdatesModel,
  online: boolean | null,
  control = controls(),
) {
  const { MachineSecurityView } = await import('./MachineSecuritySection');
  return await renderScreen(
    React.createElement(MachineSecurityView, {
      updates,
      machineName: 'shop-prod',
      online,
      controls: control,
    }),
  );
}

const row = (screen: Awaited<ReturnType<typeof render>>, testID: string) =>
  findTestInstanceByTypeWithProps(screen, Item, { testID });

describe('Machine → Security page', () => {
  it('never reads a missing count as zero', async () => {
    const neither = await render(
      model({ status: 'drifted', backend: 'apt' }),
      true,
    );
    expect(row(neither, 'machine-security-updates')?.props.title).toBe(
      t('machineDetailPage.security.countsUnknownTitle'),
    );
    expect(
      findTestInstanceByTypeWithProps(neither, RoundButton, {
        testID: 'machine-security-install',
      }),
    ).toBeUndefined();

    const onlyAll = await render(
      model({ status: 'drifted', pendingAll: 4 }),
      true,
    );
    expect(row(onlyAll, 'machine-security-updates')?.props).toMatchObject({
      title: t('machineDetailPage.security.updatesWaiting', { count: 4 }),
      subtitle: t('machineDetailPage.security.securityUnknown'),
    });

    const securityOnly = await render(
      model({ status: 'drifted', pendingSecurity: 0 }),
      true,
    );
    expect(row(securityOnly, 'machine-security-updates')?.props).toMatchObject({
      title: t('machineDetailPage.security.noSecurityWaiting'),
      subtitle: t('machineDetailPage.security.othersUnknown'),
    });
  });

  it('labels retained counts as stale while offline and after a failed check, with Check again only when it can run', async () => {
    const counts = {
      status: 'drifted' as const,
      pendingSecurity: 3,
      pendingAll: 12,
    };
    const offline = await render(model(counts, { stale: true }), false);
    const offlineLine = findTestInstanceByTypeWithProps(
      offline,
      SurfaceFreshnessLine,
      { testID: 'machine-security-stale' },
    );
    expect(offlineLine?.props.reason).toBe(
      t('machineDetailPage.security.staleOffline', { machine: 'shop-prod' }),
    );
    expect(offlineLine?.props.action).toBeUndefined();
    // The numbers stay readable under the label.
    expect(row(offline, 'machine-security-updates')?.props.title).toBe(
      t('machineDetailPage.security.securityWaiting', { count: 3 }),
    );

    const refresh = vi.fn(async () => {});
    const failed = await render(
      model(
        { ...counts, status: 'unavailable', reason: 'package_manager_busy' },
        { stale: true, refresh },
      ),
      true,
    );
    const failedLine = findTestInstanceByTypeWithProps(
      failed,
      SurfaceFreshnessLine,
      { testID: 'machine-security-stale' },
    );
    expect(failedLine?.props.reason).toBe(
      t('machineDetailPage.security.staleUnavailable', {
        reason: t('machineDetailPage.security.reasons.packageManagerBusy'),
      }),
    );
    failedLine?.props.action.onPress();
    expect(refresh).toHaveBeenCalledTimes(1);

    const fresh = await render(model(counts), true);
    expect(
      findTestInstanceByTypeWithProps(fresh, SurfaceFreshnessLine, {
        testID: 'machine-security-stale',
      }),
    ).toBeUndefined();
  });

  it('shows the restart as its own row and decision, separate from installing', async () => {
    const control = controls();
    const needed = await render(
      model({
        status: 'drifted',
        pendingSecurity: 2,
        pendingAll: 2,
        rebootNeeded: true,
      }),
      true,
      control,
    );
    expect(row(needed, 'machine-security-updates')).toBeTruthy();
    expect(row(needed, 'machine-security-restart')?.props.title).toBe(
      t('machineDetailPage.security.restartNeededTitle'),
    );
    findTestInstanceByTypeWithProps(needed, RoundButton, {
      testID: 'machine-security-restart-start',
    })?.props.onPress();
    expect(control.onReboot).toHaveBeenCalledTimes(1);
    expect(control.onPrepare).not.toHaveBeenCalled();
    findTestInstanceByTypeWithProps(needed, RoundButton, {
      testID: 'machine-security-install',
    })?.props.onPress();
    expect(control.onPrepare).toHaveBeenCalledWith('security');
    expect(control.onReboot).toHaveBeenCalledTimes(1);

    for (const rebootNeeded of [false, undefined]) {
      const quiet = await render(
        model({
          status: 'satisfied',
          pendingSecurity: 0,
          pendingAll: 0,
          ...(rebootNeeded === undefined ? {} : { rebootNeeded }),
        }),
        true,
      );
      expect(row(quiet, 'machine-security-restart')).toBeUndefined();
    }
  });
  it('says why Restart is unavailable when the Machine has not reported its installation', async () => {
    const control = controls({ canReboot: false });
    const screen = await render(model({ status: 'drifted', pendingSecurity: 1, pendingAll: 1, rebootNeeded: true }), true, control);
    expect(row(screen, 'machine-security-restart')?.props.subtitle).toBe(t('machineDetailPage.security.restartNoInstallation'));
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-security-restart-start' })?.props.disabled).toBe(true);
  });
});
