import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  presentMachineAuthorityV1,
  type MachineAuthorityInputV1,
} from '@happier-dev/protocol';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import {
  buildAdminAccessSetInput,
  describeAdminPowerHeadline,
} from './adminPower';
import type {
  MachineAdminPowerControls,
  MachineAuthorityModel,
} from './MachineAdminPowerSection';
import { settleAdminAccessSave } from './useMachineAdminAccessSave';

installMachinesSettingsCommonModuleMocks();

type Observation = NonNullable<MachineAuthorityInputV1['observation']>;
const observation = (overrides: Partial<Observation> = {}): Observation => ({
  version: 1,
  observedAt: 1,
  daemonUid: 998,
  daemonUsername: 'happier',
  daemonPrimaryGroup: 'happier',
  daemonIdentity: 'nonRoot',
  rootEquivalentGroups: ['docker'],
  groupMembership: { state: 'current' },
  passwordlessSudoToRoot: 'denied',
  managedDropIn: 'absent',
  ...overrides,
});
function authority(input: MachineAuthorityInputV1): MachineAuthorityModel {
  return {
    ...presentMachineAuthorityV1({ freshness: 'current', ...input }),
    observation: (input.observation ??
      null) as MachineAuthorityModel['observation'],
  };
}
const ask = {
  version: 1 as const,
  mode: 'ask' as const,
  administratorUsername: 'leeroy',
};

function controls(
  overrides: Partial<MachineAdminPowerControls> = {},
): MachineAdminPowerControls {
  return {
    draftMode: null,
    draftUsername: '',
    onDraftMode: vi.fn(),
    onDraftUsername: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    save: { kind: 'idle' },
    onOpenApproval: vi.fn(),
    ...overrides,
  };
}
async function render(
  model: MachineAuthorityModel,
  options: Readonly<{
    canManage?: boolean;
    control?: MachineAdminPowerControls;
    offer?: React.ReactNode;
  }> = {},
) {
  const { MachineAdminPowerView } = await import('./MachineAdminPowerSection');
  return await renderScreen(
    React.createElement(MachineAdminPowerView, {
      authority: model,
      saved: model.desiredAdminAccess ?? { version: 1, mode: 'none' },
      machineName: 'shop-prod',
      online: true,
      canManage: options.canManage ?? true,
      controls: options.control ?? controls(),
      isolationOffer: options.offer ?? null,
    }),
  );
}
const segmented = (screen: Awaited<ReturnType<typeof render>>) =>
  findTestInstanceByTypeWithProps(screen, SegmentedChoiceItem, {
    testID: 'machine-security-admin-access',
  });

describe('Machine → Security → Administrator power', () => {
  it('leads with standing power the Machine observed, and says agents can’t only when isolation is in effect', () => {
    const isolated = describeAdminPowerHeadline(
      authority({
        observation: observation(),
        desiredAdminAccess: ask,
        isolation: {
          kind: 'effective',
          platform: 'linux',
          agentUser: 'happier-agent',
        },
      }),
      'shop-prod',
    );
    expect(isolated).toEqual({
      statement: t('machineDetailPage.security.admin.headlineGroup', {
        machine: 'shop-prod',
        groups: 'docker',
      }),
      rest: `${t('machineDetailPage.security.admin.sudoStillAsks')} ${t('machineDetailPage.security.admin.agentsCant')}`,
      attention: false,
    });
    const shared = describeAdminPowerHeadline(
      authority({
        observation: observation(),
        desiredAdminAccess: ask,
        isolation: { kind: 'disabled' },
      }),
      'shop-prod',
    );
    expect(shared.rest).toBe(
      `${t('machineDetailPage.security.admin.sudoStillAsks')} ${t('machineDetailPage.security.admin.agentsToo')}`,
    );
    expect(shared.attention).toBe(true);
    // Not observed (offline or not reported): no claim about power at all.
    const unknown = describeAdminPowerHeadline(
      authority({ observation: observation(), freshness: 'stale' }),
      'shop-prod',
    );
    expect(unknown).toEqual({
      statement: t('machineDetailPage.security.admin.headlineUnknown', {
        machine: 'shop-prod',
      }),
      rest: null,
      attention: false,
    });
  });

  it('distinguishes effective per-person placement from the shared Agent setup observation', async () => {
    const shared = await render(authority({ platform: 'linux', isolationPolicy: { enabled: true },
      isolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }));
    const sharedDescription = findTestInstanceByTypeWithProps(shared, Item, { testID: 'machine-security-admin-isolation' })?.props.subtitle;
    expect(sharedDescription).toBe(t('machineDetailPage.security.admin.isolationEffective'));
    const member = await render(authority({ platform: 'linux',
      isolationPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
      isolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }));
    expect(findTestInstanceByTypeWithProps(member, Item, { testID: 'machine-security-admin-isolation' })?.props.subtitle)
      .toBe(t('machineDetailPage.security.admin.isolationMember'));
  });

  it('offers Ask and Preauthorized as unavailable, with the reason, when the Machine’s system has no elevation route', async () => {
    const screen = await render(
      authority({
        observation: observation({
          rootEquivalentGroups: [],
          reasonCode: 'platformUnsupported',
        }),
      }),
    );
    const options = segmented(screen)?.props.options as {
      id: string;
      unavailableReason?: string;
    }[];
    expect(
      options.map((option) => [option.id, option.unavailableReason]),
    ).toEqual([
      ['none', undefined],
      ['ask', t('machineDetailPage.security.admin.platformUnsupported')],
      [
        'preauthorized',
        t('machineDetailPage.security.admin.platformUnsupported'),
      ],
    ]);
  });

  it('shows a Use grantee the facts read-only: no editable control, no isolation offer, and why', async () => {
    const screen = await render(
      authority({ observation: observation(), desiredAdminAccess: ask }),
      {
        canManage: false,
        offer: React.createElement('View', { testID: 'offer' }),
      },
    );
    expect(segmented(screen)?.props.disabled).toBe(true);
    expect(
      findTestInstanceByTypeWithProps(screen, SurfaceFreshnessLine, {
        testID: 'machine-security-admin-read-only',
      })?.props.reason,
    ).toBe(
      t('machineDetailPage.security.admin.readOnly', { machine: 'shop-prod' }),
    );
    expect(screen.findAllByTestId('offer')).toHaveLength(0);
    expect(
      findTestInstanceByTypeWithProps(screen, RoundButton, {
        testID: 'machine-security-admin-save',
      }),
    ).toBeUndefined();
  });

  it('saves Ask only once a valid administrator is named', async () => {
    const model = authority({ observation: observation() });
    const invalid = await render(model, {
      control: controls({ draftMode: 'ask', draftUsername: 'root' }),
    });
    expect(
      findTestInstanceByTypeWithProps(invalid, RoundButton, {
        testID: 'machine-security-admin-save',
      })?.props.disabled,
    ).toBe(true);
    const control = controls({ draftMode: 'ask', draftUsername: 'leeroy' });
    const valid = await render(model, { control });
    const save = findTestInstanceByTypeWithProps(valid, RoundButton, {
      testID: 'machine-security-admin-save',
    });
    expect(save?.props.disabled).toBe(false);
    save?.props.onPress();
    expect(control.onSave).toHaveBeenCalledTimes(1);
  });

  it('sends the policy the person saw as the expectation, and reports a change made elsewhere as a conflict', () => {
    expect(
      buildAdminAccessSetInput({
        serverId: 's',
        machineId: 'm',
        metadataVersion: 7,
        saved: { version: 1, mode: 'none' },
        next: ask,
      }),
    ).toEqual({
      serverId: 's',
      machineId: 'm',
      expectedMetadataVersion: 7,
      expectedAdminAccess: { version: 1, mode: 'none' },
      adminAccess: ask,
      comparison: 'field',
    });
    expect(
      settleAdminAccessSave({
        ok: true,
        result: {
          status: 'conflict',
          policy: { version: 1, mode: 'preauthorized' },
          metadataVersion: 8,
        },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      settleAdminAccessSave({
        ok: true,
        result: { status: 'applied', policy: ask, metadataVersion: 8 },
      }),
    ).toEqual({ kind: 'saved' });
    expect(
      settleAdminAccessSave({
        ok: false,
        errorCode: 'approval_declined',
        error: 'declined',
      }),
    ).toEqual({ kind: 'idle' });
  });
});
