import { describe, expect, it } from 'vitest';

import {
  decideInstalledVoiceModelPackLifecycleV1,
  type InstalledVoiceModelPackMetadataV1,
} from './lifecycle.js';

const metadata: InstalledVoiceModelPackMetadataV1 = {
  schemaVersion: 1,
  identity: { pluginId: 'acme.speech', packId: 'english' },
  directoryKey: 'vp-key',
  pluginVersion: '2.0.0',
  pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
  packVersion: '1.0.0',
  manifestDigest: 'c'.repeat(64),
  verifiedAtMs: 100,
};

const source = {
  enabled: true,
  trusted: true,
  pluginVersion: metadata.pluginVersion,
  pluginSourceDigest: metadata.pluginSourceDigest,
  packVersion: metadata.packVersion,
  manifestDigest: metadata.manifestDigest,
} as const;

describe('installed public voice model-pack lifecycle', () => {
  it('keeps absent/disabled plugin packs visible but inactive and removable', () => {
    expect(decideInstalledVoiceModelPackLifecycleV1({ metadata, source: null }))
      .toEqual({ state: 'orphaned', reason: 'plugin_absent', loadable: false, removable: true, reclaimable: false });
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: { ...source, enabled: false },
    })).toMatchObject({ state: 'orphaned', reason: 'plugin_disabled', loadable: false });
  });

  it('reclaims only the same trusted immutable source identity', () => {
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source,
    })).toMatchObject({ state: 'active', reclaimable: true, loadable: true });
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: { ...source, pluginSourceDigest: `sha256:${'d'.repeat(64)}` },
    })).toMatchObject({ state: 'orphaned', reason: 'source_digest_changed', reclaimable: false, loadable: false });
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: { ...source, pluginVersion: '2.0.1' },
    })).toMatchObject({ state: 'orphaned', reason: 'plugin_version_changed', reclaimable: false, loadable: false });
  });

  it('never loads cached bytes when the declared pack version or manifest digest changed', () => {
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: { ...source, packVersion: '2.0.0' },
    })).toMatchObject({
      state: 'orphaned',
      reason: 'pack_version_changed',
      loadable: false,
      reclaimable: false,
    });
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: { ...source, manifestDigest: `sha256:${'d'.repeat(64)}` },
    })).toMatchObject({
      state: 'quarantined',
      reason: 'manifest_digest_changed',
      loadable: false,
      reclaimable: false,
    });
  });

  it('treats sha256-prefixed and bare persisted digests as the same immutable bytes', () => {
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: {
        ...source,
        pluginSourceDigest: metadata.pluginSourceDigest.replace(/^sha256:/, ''),
        manifestDigest: `sha256:${metadata.manifestDigest}`,
      },
    })).toMatchObject({ state: 'active', reason: null, loadable: true });
  });
});
