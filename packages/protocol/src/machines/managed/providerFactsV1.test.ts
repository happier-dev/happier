import { describe, expect, it } from 'vitest';
import { ManagedBootstrapCarrierV1Schema, ProviderNativeOptionFactsV1Schema, ProviderObservationV1Schema, ProviderDeletionNoticeV1Schema, resolveProviderDeletionNoticeV1, resolveProviderDeletionReminderV1 } from './providerFactsV1.js';

describe('native option presentation facts', () => {
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


  it('keeps native power, retained storage and daemon connectivity independent', () => {
    const stopped = { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' };
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
  it('requires reviewed SSH host evidence and a shared credential reference', () => {
    const carrier = { kind: 'ssh', address: 'host.example', user: 'guest', hostKeyEvidence: { hostKey: 'ssh-ed25519 observed-key', fingerprint: 'SHA256:observed' }, credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' } };
    expect(ManagedBootstrapCarrierV1Schema.safeParse(carrier).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, hostKeyEvidence: undefined }).success).toBe(false);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, privateKey: 'raw-secret' }).success).toBe(false);
  });
});
