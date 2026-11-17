import { describe, expect, it } from 'vitest';
import { MachineSetupUpdatesRolloutInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import {
  buildFleetRolloutInput,
  fleetRolloutCandidates,
  orderFleetUpdatesRows,
  readFleetUpdatesRow,
  summarizeFleetUpdates,
  type FleetMachine,
} from './machineFleetUpdates';

const machine = (
  machineId: string,
  online: boolean | null,
  installationId: string | null = `inst-${machineId}`,
): FleetMachine => ({ machineId, name: machineId, online, installationId, platform: 'linux' });
const observed = (
  pendingSecurity: number | undefined,
  pendingAll: number | undefined,
  rebootNeeded = false,
) => ({
  status: 'drifted' as const,
  backend: 'apt',
  ...(pendingSecurity === undefined ? {} : { pendingSecurity }),
  ...(pendingAll === undefined ? {} : { pendingAll }),
  rebootNeeded,
});
const plan = (machineId: string, scope: 'security' | 'all') =>
  MachineSetupEffectPlanV1Schema.parse({
    v: 1,
    basis: { kind: 'updates', machineId, scope },
    steps: [
      {
        id: 'os-updates',
        kind: 'package',
        manager: 'apt',
        packages: [{ name: 'openssl', version: '3.0.13' }],
      },
    ],
    nativeFacts: [{ stepId: 'os-updates', status: 'drifted', facts: {} }],
    planDigest: 'a'.repeat(64),
  });

describe('fleet update facts', () => {
  it('keeps unchecked coverage separate from measured zero and retains positive known updates', () => {
    const unchecked = readFleetUpdatesRow(machine('unchecked', true), undefined);
    const measuredZero = readFleetUpdatesRow(machine('zero', true), { machineId: 'zero', observation: observed(0, 0) });
    const positive = readFleetUpdatesRow(machine('positive', true), { machineId: 'positive', observation: observed(2, undefined) });
    const securityOnlyZero = readFleetUpdatesRow(machine('security-only', true), { machineId: 'security-only', observation: observed(0, undefined) });
    expect(summarizeFleetUpdates([unchecked])).toMatchObject({ checked: 0, withUpdates: 0 });
    expect(summarizeFleetUpdates([measuredZero])).toMatchObject({ checked: 1, withUpdates: 0 });
    expect(summarizeFleetUpdates([unchecked, measuredZero, positive, securityOnlyZero])).toMatchObject({ machines: 4, checked: 2, withUpdates: 1 });
  });

  it('shows an offline or unchecked Machine as unknown, never as zero, and counts only what Machines reported', () => {
    const rows = [
      readFleetUpdatesRow(machine('hetzner', true), {
        machineId: 'hetzner',
        observation: observed(3, 7),
      }),
      readFleetUpdatesRow(machine('vps', true), {
        machineId: 'vps',
        observation: observed(0, 2, true),
      }),
      readFleetUpdatesRow(machine('laptop', true), {
        machineId: 'laptop',
        observation: null,
      }),
      readFleetUpdatesRow(machine('build', false), {
        machineId: 'build',
        observation: observed(4, 9, true),
      }),
    ];
    expect(
      rows.map((row) => [row.security, row.all, row.restartNeeded]),
    ).toEqual([
      [3, 7, false],
      [0, 2, true],
      [null, null, false],
      [null, null, false],
    ]);
    expect(summarizeFleetUpdates(rows)).toEqual({
      machines: 4,
      checked: 2,
      withUpdates: 2,
      security: 3,
      restarts: 1,
      offline: ['build'],
    });
    expect(
      fleetRolloutCandidates(rows, 'security').map((row) => row.machineId),
    ).toEqual(['hetzner']);
    expect(
      fleetRolloutCandidates(rows, 'all').map((row) => row.machineId),
    ).toEqual(['hetzner', 'vps']);
    // Security first, then other updates or a restart, then unchecked online, then offline.
    expect(orderFleetUpdatesRows([...rows].reverse()).map((row) => row.machineId)).toEqual(['hetzner', 'vps', 'laptop', 'build']);
  });
});

describe('the reviewed rollout input', () => {
  it('rolls out one Machine at a time from an online Machine outside the rollout, restarting only where it can name the installation', () => {
    const input = buildFleetRolloutInput({
      homeId: 'home-1',
      targets: [
        {
          machine: machine('hetzner', true),
          scope: 'security',
          plan: plan('hetzner', 'security'),
        },
        {
          machine: machine('vps', true, null),
          scope: 'security',
          plan: plan('vps', 'security'),
        },
      ],
      others: [machine('build', false), machine('laptop', true)],
      failurePolicy: 'fail_stop',
      restartIfNeeded: true,
    });
    expect(MachineSetupUpdatesRolloutInputV1Schema.parse(input)).toEqual(input);
    expect(input.machineId).toBe('laptop');
    expect(
      input.batches.map((batch) =>
        batch.map((target) => [
          target.machineId,
          target.reboot?.expectedInstallationId ?? null,
        ]),
      ),
    ).toEqual([[['hetzner', 'inst-hetzner']], [['vps', null]]]);
  });

  it('runs on the last target when no other Machine is online, so its own restart cannot end the run early', () => {
    const input = buildFleetRolloutInput({
      homeId: 'home-1',
      targets: [
        {
          machine: machine('hetzner', true),
          scope: 'all',
          plan: plan('hetzner', 'all'),
        },
        {
          machine: machine('vps', true),
          scope: 'all',
          plan: plan('vps', 'all'),
        },
      ],
      others: [machine('build', false)],
      failurePolicy: 'collect_outcomes',
      restartIfNeeded: false,
    });
    expect(input.machineId).toBe('vps');
    expect(input.failurePolicy).toBe('collect_outcomes');
    expect(
      input.batches
        .flat()
        .map((target) => [target.machineId, 'reboot' in target]),
    ).toEqual([
      ['hetzner', false],
      ['vps', false],
    ]);
  });
});
