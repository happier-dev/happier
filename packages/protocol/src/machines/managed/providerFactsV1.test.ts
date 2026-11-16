import { describe, expect, it } from 'vitest';
import { AcquireResultV1Schema, ManagedBootstrapCarrierV1Schema, ManagedPrerequisiteV1Schema, ProviderNativeOptionFactsV1Schema, ProviderObservationV1Schema,
  ProviderDeletionNoticeV1Schema, resolveProviderDeletionNoticeV1, resolveProviderDeletionReminderV1, RetentionCapabilitiesV1Schema } from './providerFactsV1.js';
import { MachineProvisionerDestroyResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';

describe('prerequisite Setup preview', () => {
  it('carries the same source selection into the existing reviewed Setup plan', () => {
    const prerequisite = {
      requirement: { kind: 'managedDependency', id: { pluginId: 'fixture.runtime', localId: 'engine' } },
      status: 'unavailable',
      setupSources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId: 'fixture.recipes', recipeId: 'engine', revision: '1' }, inputs: {},
      } }] } }],
    };
    expect(ManagedPrerequisiteV1Schema.parse(prerequisite)).toEqual(prerequisite);
    for (const setupSources of [[], [...prerequisite.setupSources, ...prerequisite.setupSources], [
      ...prerequisite.setupSources,
      { kind: 'accountPreset', presetId: 'opened', presetRevision: 1, contentEncryptionMode: 'plain', setup: {} },
    ]]) {
      expect(ManagedPrerequisiteV1Schema.safeParse({ ...prerequisite, setupSources }).success).toBe(false);
    }
  });
});

describe('native acquisition failure facts', () => {
  it('retains a failed native Delete command through the strict destroy reader', () => {
    const result = { kind: 'unknown', code: 'native_command_failed',
      nativeCause: { localCause: 'native_command_failed', command: 'delete', exitCode: 1 } };
    expect(MachineProvisionerDestroyResultV1Schema.parse(result)).toEqual(result);
  });
  it.each(['create', 'run', 'up'])('carries equivalent native acquisition command %s through the shared reader', command => {
    const result = { kind: 'unknown', recovery: { reference: 'owned-instance', reason: 'native_acquisition_unconfirmed' },
      nativeCause: { localCause: 'native_command_failed', command, exitCode: 1, stderr: 'boot failed' } };
    expect(AcquireResultV1Schema.parse(result)).toEqual(result);
  });
  it('carries bounded projected native command diagnostics through acquisition without accepting command payloads', () => {
    const result = { kind: 'unknown', recovery: { reference: '/store/guest', reason: 'lima_start_failed' },
      nativeCause: { localCause: 'native_command_failed', command: 'start', exitCode: 1, stderr: 'no such file or directory' } };
    expect(AcquireResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { ...result.nativeCause, argv: ['private'] },
      { ...result.nativeCause, command: 'shell' },
      { ...result.nativeCause, stderr: 'x'.repeat(10_001) },
    ]) expect(AcquireResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
  });
  it('retains only a leaf-qualified guest shutdown effect independently of provider API support', () => {
    for (const guestLocalStop of ['poweroff', 'process-exit']) {
      const capabilities = { supportedIntents: ['start', 'stop'], guestLocalStop };
      expect(RetentionCapabilitiesV1Schema.parse(capabilities)).toEqual(capabilities);
    }
    expect(RetentionCapabilitiesV1Schema.safeParse({ supportedIntents: ['stop'], guestLocalStop: 'native-idle' }).success).toBe(false);
  });
  it('keeps native resource observations independent of daemon connectivity', () => {
    const observation = { observedAt: 1, availability: 'present', power: 'running' };
    expect(ProviderObservationV1Schema.parse(observation)).toEqual(observation);
    expect(ProviderObservationV1Schema.safeParse({ ...observation, daemon: 'unknown' }).success).toBe(false);
  });
  it('carries a closed native route404 cause through the strict destroy reader', () => {
    const result = { kind: 'refused', code: 'native_route_not_found',
      nativeCause: { localCause: 'native_route_not_found', route: 'stop', httpStatus: 404 } };
    expect(MachineProvisionerDestroyResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { ...result.nativeCause, route: '/private/path' },
      { ...result.nativeCause, httpStatus: 400 },
      { ...result.nativeCause, message: 'private vendor diagnostics' },
    ]) expect(MachineProvisionerDestroyResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
  });
  it('retains only bounded documented rejected field names, never native messages or reflected input', () => {
    const result = { kind: 'rejected', code: 'provider_unavailable',
      nativeCause: { httpStatusClass: '4xx', code: 'invalid_input', fields: ['name', 'image', 'public_net', 'user_data'] } };
    expect(AcquireResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { ...result.nativeCause, fields: ['private-token'] },
      { ...result.nativeCause, fields: [{ name: 'image', messages: ['private response'] }] },
      { ...result.nativeCause, fields: Array(15).fill('image') },
      { ...result.nativeCause, message: 'private response' },
      { ...result.nativeCause, code: 'unauthorized' },
    ]) expect(AcquireResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
    expect(AcquireResultV1Schema.parse({ ...result, nativeCause: { ...result.nativeCause, code: 'uniqueness_error', fields: ['name'] } }))
      .toMatchObject({ nativeCause: { fields: ['name'] } });
  });
  it('carries a definite native Delete refusal without native response content', () => {
    const result = { kind: 'refused', code: 'provider_unavailable',
      nativeCause: { localCause: 'native_delete_refused', httpStatus: 400 } };
    expect(MachineProvisionerDestroyResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { ...result.nativeCause, message: 'private native response' },
      { ...result.nativeCause, httpStatus: 500 },
    ]) expect(MachineProvisionerDestroyResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
  });
  it('retains a message-only configure refusal as a bounded local cause with its exact HTTP status', () => {
    const result = { kind: 'pending', nativeOperationRef: { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' },
      schemaVersion: 1, value: { name: 'retained' } }, nativeCause: { localCause: 'native_configure_refused', httpStatus: 400 } };
    expect(AcquireResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { ...result.nativeCause, message: 'private' },
      { ...result.nativeCause, httpStatus: 200 },
      { ...result.nativeCause, localCause: 'private-message' },
    ]) expect(AcquireResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
  });

  it('preserves bounded local qualification causes without admitting native content', () => {
    for (const localCause of ['native_options_changed', 'native_ssh_network_unavailable', 'native_route_unavailable', 'native_lease_ended', 'native_macos_vm_limit_reached']) {
      const result = { kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause } };
      expect(AcquireResultV1Schema.parse(result)).toEqual(result);
      expect(AcquireResultV1Schema.safeParse({ ...result, nativeCause: { localCause, message: 'private' } }).success).toBe(false);
    }
    expect(AcquireResultV1Schema.safeParse({ kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'private-native-content' } }).success).toBe(false);
  });

  it('preserves documented native codes while rejecting content and unrecognized codes', () => {
    const result = { kind: 'rejected', code: 'provider_unavailable', nativeCause: { httpStatusClass: '4xx', code: 'resource_limit_exceeded' } };
    expect(AcquireResultV1Schema.parse(result)).toEqual(result);
    for (const nativeCause of [
      { httpStatusClass: '4xx', code: 'private-account-token' },
      { httpStatusClass: '4xx', message: 'private vendor response' },
      { grpcStatusCode: 17 },
    ]) expect(AcquireResultV1Schema.safeParse({ ...result, nativeCause }).success).toBe(false);
    expect(AcquireResultV1Schema.parse({ ...result, nativeCause: { grpcStatusCode: 7 } }))
      .toEqual({ ...result, nativeCause: { grpcStatusCode: 7 } });
  });
});

describe('native option presentation facts', () => {
  it('carries the provider selected preparation target and installation home without guessing missing facts', () => {
    const preparationGuest = { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' };
    expect(ProviderNativeOptionFactsV1Schema.parse({ preparationGuest })).toEqual({ preparationGuest });
    expect(ProviderNativeOptionFactsV1Schema.parse({})).toEqual({});
    for (const invalid of [
      { ...preparationGuest, target: { os: 'win32', arch: 'x64' } },
      { ...preparationGuest, target: { os: 'linux', arch: 'ia32' } },
      { target: preparationGuest.target },
      { ...preparationGuest, remoteHomeDir: '' },
      { ...preparationGuest, credential: 'undeclared' },
    ]) expect(ProviderNativeOptionFactsV1Schema.safeParse({ preparationGuest: invalid }).success).toBe(false);
  });

  it('preserves declarative image metadata and native country codes without admitting executable or remote previews', () => {
    const facts = {
      image: { id: 'ubuntu', title: 'Ubuntu', description: 'Ubuntu 24.04 LTS',
        preview: { resource: { pluginId: 'fixture.compute', localId: 'ubuntu-preview' }, accessibilityLabel: 'Ubuntu desktop' } },
      location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' },
    };
    expect(ProviderNativeOptionFactsV1Schema.parse(facts)).toEqual(facts);
    expect(ProviderNativeOptionFactsV1Schema.parse({ image: { id: 'ubuntu', title: 'Ubuntu' }, location: { id: 'local', title: 'This computer' } }))
      .toEqual({ image: { id: 'ubuntu', title: 'Ubuntu' }, location: { id: 'local', title: 'This computer' } });
    for (const preview of [{ uri: 'https://example.test/ubuntu.png' }, { resource: { pluginId: 'fixture.compute', localId: 'ubuntu-preview', privateKey: 'secret' } }, () => 'component']) {
      expect(ProviderNativeOptionFactsV1Schema.safeParse({ image: { ...facts.image, preview } }).success).toBe(false);
    }
    expect(ProviderNativeOptionFactsV1Schema.safeParse({ location: { ...facts.location, countryCode: 'Germany' } }).success).toBe(false);
  });
});

describe('managed bootstrap transport custody', () => {
  it('projects one exact lead-time boundary for Inbox and native notification scheduling without a timer', () => {
    const notice = ProviderDeletionNoticeV1Schema.parse({ kind: 'stopped-storage', at: 10_000,
      rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1_000 }, consequence: 'disk-deleted' });
    const observation = { deletionNotices: [notice] };
    expect(resolveProviderDeletionReminderV1({ observation, leadTimeMs: 2_000, nowMs: 7_999 }))
      .toEqual({ notice, remindAt: 8_000, due: false });
    expect(resolveProviderDeletionReminderV1({ observation, leadTimeMs: 2_000, nowMs: 8_000 }))
      .toEqual({ notice, remindAt: 8_000, due: true });
    expect(resolveProviderDeletionReminderV1({ observation, leadTimeMs: 0, nowMs: 8_000 }))
      .toEqual({ notice, remindAt: 10_000, due: false });
    expect(resolveProviderDeletionReminderV1({ observation: { deletionNotices: [{ ...notice, at: undefined }] },
      leadTimeMs: 2_000, nowMs: 8_000 })).toBeNull();
    expect(resolveProviderDeletionReminderV1({ observation: { deletionNotices: [] },
      leadTimeMs: 2_000, nowMs: 8_000 })).toBeNull();
  });

  it('selects the nearest native notice, preserves overdue evidence and honors explicit withdrawal', () => {
    const ruleOnly = ProviderDeletionNoticeV1Schema.parse({ kind: 'stopped-storage',
      rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1_000 }, consequence: 'disk-deleted' });
    const later = { ...ruleOnly, at: 300 };
    const nearest = { ...ruleOnly, at: 100 };
    const retentionCapabilities = { deletionNotices: [ruleOnly] };
    expect(resolveProviderDeletionNoticeV1({ retentionCapabilities })).toEqual(ruleOnly);
    expect(resolveProviderDeletionNoticeV1({ retentionCapabilities,
      observation: { deletionNotices: [ruleOnly, later, nearest] } })).toEqual(nearest);
    expect(resolveProviderDeletionNoticeV1({ retentionCapabilities, observation: { deletionNotices: [] } })).toBeNull();
    expect(resolveProviderDeletionNoticeV1({})).toBeNull();
  });

  it('preserves native stopped-disk deletion evidence without inventing an unknown stop date', () => {
    const rule = { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1_000 };
    const observation = {
      observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained',
      deletionNotices: [{ kind: 'stopped-storage', rule, consequence: 'disk-deleted' }],
    };
    expect(ProviderObservationV1Schema.parse(observation)).toEqual(observation);
    const dated = { ...observation, deletionNotices: [{ ...observation.deletionNotices[0], at: 100 }] };
    expect(ProviderObservationV1Schema.parse(dated)).toEqual(dated);
    expect(ProviderObservationV1Schema.parse({ ...observation, deletionNotices: [] })).toMatchObject({ deletionNotices: [] });
  });

  it('preserves deletion on stop without inventing a deadline and rejects negative delays', () => {
    const notice = ProviderDeletionNoticeV1Schema.parse({ kind: 'stopped-storage',
      rule: { kind: 'after-stop', afterMs: 0 }, consequence: 'disk-deleted' });
    expect(ProviderObservationV1Schema.parse({ observedAt: 1, availability: 'present',
      deletionNotices: [notice] }).deletionNotices).toEqual([notice]);
    expect(resolveProviderDeletionNoticeV1({ retentionCapabilities: { deletionNotices: [notice] } })).toEqual(notice);
    expect(resolveProviderDeletionReminderV1({ observation: { deletionNotices: [notice] },
      leadTimeMs: 0, nowMs: 1 })).toBeNull();
    expect(ProviderDeletionNoticeV1Schema.safeParse({ ...notice, rule: { kind: 'after-stop', afterMs: -1 } }).success).toBe(false);
  });

  it('keeps native power and retained storage independent', () => {
    const stopped = { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' };
    expect(ProviderObservationV1Schema.parse(stopped)).toEqual(stopped);
    expect(ProviderObservationV1Schema.parse({ ...stopped, power: 'running', storage: 'lost' }).storage).toBe('lost');
    expect(ProviderObservationV1Schema.parse({ observedAt: 10, availability: 'present' }).storage).toBeUndefined();
    expect(ProviderObservationV1Schema.safeParse({ ...stopped, prompt: 'private' }).success).toBe(false);
  });
  it('selects a native transport without copying native identity or secret material', () => {
    const carrier = { kind: 'native', transport: { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1 } };
    expect(ManagedBootstrapCarrierV1Schema.safeParse(carrier).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, resource: { id: 'native' } }).success).toBe(false);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, privateKey: 'secret' }).success).toBe(false);
  });
  it('keeps observed SSH evidence optional while requiring retained credential custody', () => {
    const carrier = { kind: 'ssh', address: 'host.example', user: 'guest', hostKeyEvidence: { hostKey: 'ssh-ed25519 observed-key', fingerprint: 'SHA256:observed' }, credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' } };
    expect(ManagedBootstrapCarrierV1Schema.safeParse(carrier).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, hostKeyEvidence: undefined }).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, credentialRef: undefined }).success).toBe(false);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, privateKey: 'raw-secret' }).success).toBe(false);
  });
});
