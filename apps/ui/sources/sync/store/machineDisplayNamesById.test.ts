import { afterEach, expect, it } from 'vitest';

import {
  createMachineFixture,
  createMachineMetadataFixture,
} from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import { readMachineDisplayNamesById } from './hooks';

const baseline = storage.getState();
afterEach(() => {
  storage.setState(baseline, true);
});

const named = (id: string, displayName: string) =>
  createMachineFixture({
    id,
    metadata: createMachineMetadataFixture({ displayName, host: 'nldw6' }),
  });

// QA-DEPLOY-1114 #11: a fact line ("Healthy · {machine}", a Domain's route, a receipt) names a Machine the way the
// Machine list does, so 14 same-named Machines are not all "NLDW6-3-11-20".
it('names Machines in fact lines as the Machine list does: same-named ones told apart, a unique one unchanged', () => {
  const machines = [
    named('2e0f09b5-aaaa', 'NLDW6-3-11-20'),
    named('87520e99-bbbb', 'NLDW6-3-11-20'),
    named('c0ffee00-cccc', 'Studio'),
  ];
  storage
    .getState()
    .applyMachines(machines, true, {
      sourceServerId: getActiveServerSnapshot().serverId,
    });

  const names = readMachineDisplayNamesById(
    storage.getState(),
    machines.map((machine) => machine.id),
  );
  const listed = resolveMachineDisplayNames(machines);

  expect(names['2e0f09b5-aaaa']).toBe(listed.get('2e0f09b5-aaaa'));
  expect(names['87520e99-bbbb']).toBe(listed.get('87520e99-bbbb'));
  expect(names['2e0f09b5-aaaa']).not.toBe(names['87520e99-bbbb']);
  expect(names['c0ffee00-cccc']).toBe('Studio');
});

it('leaves out a Machine it has nothing to call yet, rather than a placeholder', () => {
  const unread = createMachineFixture({
    id: 'locked-1',
    metadata: null,
    availability: { kind: 'locked', reason: 'decryption_failed' },
  });
  storage
    .getState()
    .applyMachines([unread], true, {
      sourceServerId: getActiveServerSnapshot().serverId,
    });
  expect(
    readMachineDisplayNamesById(storage.getState(), ['locked-1', 'never-seen']),
  ).toEqual({});
});
