import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { projectMachineSetupStepChecklist } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import {
  removeServerProfile,
  upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { getPreferredLanguage, t } from '@/text';

import { MachineSetupRunRegion } from './MachineSetupRunRegion';

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

const initialState = storage.getState();
let home = '';
beforeEach(async () => {
  storage.setState(initialState, true);
  home = (
    await upsertServerProfile({
      serverUrl: 'https://setup-run.example.test',
      name: 'Home',
    })
  ).id;
});
afterEach(async () => {
  await standardCleanup();
  storage.setState(initialState, true);
  await removeServerProfile(home);
});

const SETTLED_AT = Date.UTC(2026, 10, 18, 10, 55);

function finishedRun(
  preset: Readonly<{ id: string; revision: number; name?: string }>,
) {
  const snapshot = ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: 'run',
    revision: 3,
    actionId: 'machines.setup.apply',
    state: 'succeeded',
    scope: { accountId: 'account', machineId: 'devbox' },
    title: 'Apply machine setup',
    createdAt: SETTLED_AT - 60_000,
    startedAt: SETTLED_AT - 59_000,
    settledAt: SETTLED_AT,
    cancellation: 'unsupported',
    domainRef: {
      kind: 'machineSetup',
      serverId: 'srv',
      machineId: 'devbox',
      preset,
      steps: [
        {
          planIndex: 0,
          stepId: 'redis',
          label: { key: 'redis', fallback: 'Redis 7' },
          state: 'succeeded',
        },
      ],
    },
  });
  const operation = {
    serverId: home,
    snapshot,
    observation: 'available' as const,
    isUnavailableProjection: false,
  };
  if (snapshot.domainRef?.kind !== 'machineSetup')
    throw new Error('expected a machineSetup operation');
  const steps = projectMachineSetupStepChecklist(
    snapshot.domainRef,
    (label) => label.fallback,
  )!;
  return { operation, steps };
}

describe('Machine Setup run region (lab L7-done)', () => {
  it.each([false, true])('heads a finished run with its preset and only reports a completed post-run check (%s)', async checkedAfter => {
    const { operation, steps } = finishedRun({
      id: 'acme',
      revision: 7,
      name: 'Acme dev box',
    });
    const screen = await renderScreen(
      <MachineSetupRunRegion
        serverId={home}
        operation={operation}
        progressOperation={operation}
        steps={steps}
        machineName="devbox"
        onRetry={null}
        checkedAfter={checkedAfter}
      />,
    );
    const titled = screen.tree.findAll(
      (node) =>
        node.props?.title ===
        t('machinePresets.setup.tab.presetIsOn', {
          preset: 'Acme dev box',
          revision: 7,
          machine: 'devbox',
        }),
    );
    expect(titled.length).toBeGreaterThan(0);
    expect(titled[0]!.props.subtitle).toBe(
      t(checkedAfter ? 'machinePresets.setup.tab.finishedAndChecked' : 'machinePresets.setup.tab.finishedAt', {
        time: formatHappierAsOfTime(
          SETTLED_AT,
          Date.now(),
          getPreferredLanguage(),
        ),
      }),
    );
    await screen.unmount();
  });

  it("keeps the operation's own title when the run names no preset", async () => {
    const { operation, steps } = finishedRun({ id: 'direct', revision: 0 });
    const screen = await renderScreen(
      <MachineSetupRunRegion
        serverId={home}
        operation={operation}
        progressOperation={operation}
        steps={steps}
        machineName="devbox"
        onRetry={null}
      />,
    );
    expect(
      screen.tree.findAll((node) => node.props?.title === 'Apply machine setup')
        .length,
    ).toBeGreaterThan(0);
    await screen.unmount();
  });
});
