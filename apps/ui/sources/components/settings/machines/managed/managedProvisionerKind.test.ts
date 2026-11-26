import { afterEach, describe, expect, it } from 'vitest';

import {
  createMachineFixture,
  createMachineMetadataFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';

import { describeManagedAcquireApprovalLine } from './managedProvisionerKind';

const initial = storage.getState();
afterEach(() => storage.setState(initial, true));

const STUDIO = createMachineFixture({
  id: 'studio-mac',
  metadata: createMachineMetadataFixture({ displayName: 'Studio Mac' }),
});

function limaCreate(
  controller?: Readonly<{ machineId: string; installationId: string }>,
) {
  return {
    selection: {
      kind: 'one-off',
      homeId: 'home',
      ...(controller ? { controller } : {}),
      launch: {
        provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
        schemaVersion: 1,
        name: 'Build box',
        choices: {},
      },
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
    },
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
  };
}

describe("a managed Create's fact line", () => {
  it('names the machine that manages the new one once this device can name it', () => {
    storage.setState({ machineListByServerId: { home: [STUDIO] } });
    const line =
      describeManagedAcquireApprovalLine(
        limaCreate({ machineId: STUDIO.id, installationId: 'installed' }),
      ) ?? '';
    const kind = line.split(' · ')[0] ?? '';
    expect(kind).toMatch(/^Lima .+ on Studio Mac$/);
    expect(line).not.toContain('happier.machine.lima');
  });

  it('keeps the kind alone while the managing machine has no settled name, and when there is none', () => {
    const unnamed =
      describeManagedAcquireApprovalLine(
        limaCreate({
          machineId: 'not-yet-listed',
          installationId: 'installed',
        }),
      ) ?? '';
    const local = describeManagedAcquireApprovalLine(limaCreate()) ?? '';
    for (const line of [unnamed, local]) {
      expect(line).toMatch(/^Lima /);
      expect(line).not.toContain(' on ');
      expect(line).not.toContain('happier.machine.lima');
    }
  });
});
