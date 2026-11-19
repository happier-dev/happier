import { describe, expect, it, vi } from 'vitest';

import type { AccessibleMachineAccessV1 } from '@happier-dev/protocol/machines/machineAccessV1';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { t } from '@/text';
import { english } from '@/text/translations/machineDetailPageTranslations.shared';
import { MACHINE_DEPLOYMENT_ROLES } from '@/components/machines/services/machineServicesPresentation';

import { composeMachinePageHeaderFacts, composeMachineShareSubtitle } from './MachinePageHeader';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const access = (displayName: string): AccessibleMachineAccessV1 => ({
  custodian: { accountId: 'ben', displayName },
  role: 'use',
  resourceMode: 'e2ee',
  accessState: 'ready',
});

describe('machine page header facts', () => {
  it('keeps generated hosts out of managed identity facts while retaining ordinary machine host facts', () => {
    const machine = createMachineFixture();
    machine.metadata = { ...machine.metadata!, displayName: 'Build box', host: 'lima-generated-host' };
    const input = { machine, online: true, encryptionMode: null, replacedByMachineLabel: null } as const;
    expect(composeMachinePageHeaderFacts({ ...input, managedMeta: [] }).map(fact => fact.key)).not.toContain('host');
    expect(composeMachinePageHeaderFacts({ ...input, managedMeta: undefined })).toContainEqual({ key: 'host', text: 'lima-generated-host' });
  });
  it('leads a created machine\'s facts with its power word, once, before its kind (lab m-detail)', () => {
    const facts = composeMachinePageHeaderFacts({ machine: createMachineFixture(), online: false, managedPowerWord: 'Asleep',
      managedMeta: [{ key: 'managed-kind', text: 'Lima machine' }], encryptionMode: null, replacedByMachineLabel: null });
    expect(facts.slice(0, 2)).toEqual([
      { key: 'presence', text: 'Asleep', testID: 'machine-detail-presence' },
      { key: 'managed-kind', text: 'Lima machine' },
    ]);
    expect(facts.filter(fact => fact.text === 'Asleep')).toHaveLength(1);
  });
  it('says whose machine it is right after presence when it is shared with you, and never for your own', () => {
    const facts = (isShared: boolean, owner: string) =>
      composeMachinePageHeaderFacts({
        machine: createMachineFixture({ isShared, access: access(owner) }),
        online: true,
        managedMeta: undefined,
        encryptionMode: 'e2ee',
        replacedByMachineLabel: null,
      }).map((fact) => fact.key);
    // Identity first (lab m-share T "Online · Ben's · End-to-end encrypted"): the owner leads the facts after presence.
    expect(facts(true, 'Ben').slice(0, 2)).toEqual(['presence', 'owner']);
    expect(facts(false, 'Ben')).not.toContain('owner');
    // An owner without a public name is left out, never drawn as a bare "'s".
    expect(facts(true, ' ')).not.toContain('owner');
  });
  it('names what the Machine does for Environments right after presence, once per role, and nothing without a role', () => {
    const machine = createMachineFixture();
    const env = (environmentId: string, title: string, roles: readonly ('runtime' | 'controller' | 'build' | 'edge' | 'data')[]) =>
      ({ environmentId, title, projectSourceId: 'src', roles });
    const facts = composeMachinePageHeaderFacts({ machine, online: true, managedMeta: undefined, encryptionMode: null,
      replacedByMachineLabel: null, roleEnvironments: [env('e1', 'Production', ['build', 'controller']),
        env('e2', 'Staging', ['controller', 'runtime']), env('e3', 'Docs', ['edge'])] });
    // The Services tab's reading order; runtime and data are services, not roles the header names.
    expect(facts.slice(0, 4).map(fact => fact.key)).toEqual(['presence', 'role-controller', 'role-build', 'role-edge']);
    // The chip says what the role means and for which Environments.
    expect(facts.find(fact => fact.key === 'role-controller')?.accessibilityLabel).toContain('Production');
    expect(facts.find(fact => fact.key === 'role-controller')?.accessibilityLabel).toContain('Staging');
    // A role serving one Environment links to it; one serving several can't say which, so it is plain text.
    const opened: string[] = [];
    const linked = composeMachinePageHeaderFacts({ machine, online: true, managedMeta: undefined, encryptionMode: null,
      replacedByMachineLabel: null, roleEnvironments: [env('e1', 'Production', ['controller']), env('e3', 'Docs', ['edge', 'controller'])],
      onOpenEnvironment: (environment) => opened.push(environment.environmentId) });
    linked.find(fact => fact.key === 'role-edge')?.onPress?.();
    // Every role word is a real translation in the English catalog the locales mirror, never a raw key.
    for (const role of MACHINE_DEPLOYMENT_ROLES) expect(typeof english.machineServices.roles.role[role]).toBe('string');
    expect(linked.find(fact => fact.key === 'role-edge')?.text).toBe(t('machineServices.roles.role.edge'));
    expect(opened).toEqual(['e3']);
    expect(linked.find(fact => fact.key === 'role-controller')?.onPress).toBeUndefined();
    const none = composeMachinePageHeaderFacts({ machine, online: true, managedMeta: undefined, encryptionMode: null,
      replacedByMachineLabel: null, roleEnvironments: [env('e4', 'Shop', ['runtime', 'data'])] });
    expect(none.some(fact => fact.key.startsWith('role-'))).toBe(false);
  });
  it('gives the share sheet the short identity line: kind, OS and encryption, without presence, size or CLI (lab m-share S)', () => {
    const base = createMachineFixture();
    const machine = createMachineFixture({ metadata: { ...base.metadata!, platform: 'linux', arch: 'x64' },
      daemonState: { ...(base.daemonState as object), cliVersion: '0.3.0' } });
    const subtitle = (managedMeta: readonly { key: string; text: string }[] | undefined) => composeMachineShareSubtitle({ machine, encryptionMode: 'e2ee',
      managedMeta });
    expect(subtitle([{ key: 'managed-kind', text: 'Lima machine' }])).toBe(['Lima machine', 'Linux', t('settingsAccount.endToEndEncrypted')].join(' · '));
    expect(subtitle(undefined)).toBe([t('machines.sharing.kind'), 'Linux', t('settingsAccount.endToEndEncrypted')].join(' · '));
  });
});
