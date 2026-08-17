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
  artifactBinding: {
    kind: 'sourceIntegrity',
    integrity: `sha512-${'b'.repeat(86)}==`,
  },
  packVersion: '1.0.0',
  manifestDigest: 'c'.repeat(64),
  verifiedAtMs: 100,
};

const source = {
  enabled: true,
  trusted: true,
  pluginVersion: metadata.pluginVersion,
  artifactBinding: metadata.artifactBinding,
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
      source: {
        ...source,
        artifactBinding: { kind: 'sourceIntegrity', integrity: `sha512-${'d'.repeat(86)}==` },
      },
    })).toMatchObject({ state: 'orphaned', reason: 'artifact_binding_changed', reclaimable: false, loadable: false });
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

  it('keeps manifest-digest prefix normalization separate from the exact artifact binding', () => {
    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: {
        ...source,
        manifestDigest: `sha256:${metadata.manifestDigest}`,
      },
    })).toMatchObject({ state: 'active', reason: null, loadable: true });
  });

  it('fails closed when a Voice artifact-binding variant or value changes', () => {
    const sourceIntegrity = Object.freeze({
      kind: 'sourceIntegrity' as const,
      integrity: `sha512-${'a'.repeat(86)}==`,
    });
    const boundMetadata: InstalledVoiceModelPackMetadataV1 = {
      ...metadata,
      artifactBinding: sourceIntegrity,
    };
    const boundSource = {
      ...source,
      artifactBinding: sourceIntegrity,
    };

    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata: boundMetadata,
      source: boundSource,
    })).toMatchObject({ state: 'active', reason: null, loadable: true });

    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata: boundMetadata,
      source: {
        ...boundSource,
        artifactBinding: Object.freeze({
          kind: 'sourceIntegrity' as const,
          integrity: `sha512-${'b'.repeat(86)}==`,
        }),
      },
    })).toMatchObject({
      state: 'orphaned',
      reason: 'artifact_binding_changed',
      reclaimable: false,
      loadable: false,
    });

    expect(decideInstalledVoiceModelPackLifecycleV1({
      metadata: boundMetadata,
      source: {
        ...boundSource,
        artifactBinding: Object.freeze({
          kind: 'materialization' as const,
          immutableGenerationId: 'generation-local-2',
        }),
      },
    })).toMatchObject({
      state: 'orphaned',
      reason: 'artifact_binding_changed',
      reclaimable: false,
      loadable: false,
    });
  });
});
