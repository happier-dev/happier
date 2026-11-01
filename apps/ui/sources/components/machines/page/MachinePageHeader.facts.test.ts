import { describe, expect, it, vi } from 'vitest';


import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { composeMachinePageHeaderFacts } from './MachinePageHeader';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

describe('machine page header facts', () => {
  it('keeps generated hosts out of managed identity facts while retaining ordinary machine host facts', () => {
    const machine = createMachineFixture();
    machine.metadata = { ...machine.metadata!, displayName: 'Build box', host: 'lima-generated-host' };
    const input = { machine, online: true, encryptionMode: null, replacedByMachineLabel: null } as const;
    expect(composeMachinePageHeaderFacts({ ...input, managedMeta: [] }).map(fact => fact.key)).not.toContain('host');
    expect(composeMachinePageHeaderFacts({ ...input, managedMeta: undefined })).toContainEqual({ key: 'host', text: 'lima-generated-host' });
  });
});
