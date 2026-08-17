import type { VoiceModelPackIdentityV1 } from './publicCatalog.js';
import {
  voiceModelPackArtifactBindingsEqualV1,
  type VoiceModelPackArtifactBindingV1,
} from './artifactBinding.js';
import { voiceModelPackSha256DigestsEqualV1 } from './sha256Digest.js';

export type InstalledVoiceModelPackMetadataV1 = Readonly<{
  schemaVersion: 1;
  identity: VoiceModelPackIdentityV1;
  directoryKey: string;
  pluginVersion: string;
  artifactBinding: VoiceModelPackArtifactBindingV1;
  packVersion: string;
  manifestDigest: string;
  verifiedAtMs: number;
}>;

export type InstalledVoiceModelPackSourceStateV1 = Readonly<{
  enabled: boolean;
  trusted: boolean;
  pluginVersion: string;
  artifactBinding: VoiceModelPackArtifactBindingV1;
  packVersion: string;
  manifestDigest: string;
}>;

export type InstalledVoiceModelPackLifecycleDecisionV1 = Readonly<{
  state: 'active' | 'orphaned' | 'quarantined';
  reason: 'plugin_absent' | 'pack_absent' | 'plugin_disabled' | 'source_untrusted' | 'plugin_version_changed' | 'artifact_binding_changed' | 'pack_version_changed' | 'manifest_digest_changed' | null;
  loadable: boolean;
  removable: boolean;
  reclaimable: boolean;
}>;

export function decideInstalledVoiceModelPackLifecycleV1(params: Readonly<{
  metadata: InstalledVoiceModelPackMetadataV1;
  source: InstalledVoiceModelPackSourceStateV1 | null;
}>): InstalledVoiceModelPackLifecycleDecisionV1 {
  const decision = (
    state: InstalledVoiceModelPackLifecycleDecisionV1['state'],
    reason: InstalledVoiceModelPackLifecycleDecisionV1['reason'],
    loadable: boolean,
    reclaimable: boolean,
  ): InstalledVoiceModelPackLifecycleDecisionV1 => Object.freeze({
    state,
    reason,
    loadable,
    removable: true,
    reclaimable,
  });
  if (!params.source) return decision('orphaned', 'plugin_absent', false, false);
  if (!params.source.enabled) return decision('orphaned', 'plugin_disabled', false, false);
  if (!params.source.trusted) return decision('orphaned', 'source_untrusted', false, false);
  if (params.source.pluginVersion !== params.metadata.pluginVersion) {
    return decision('orphaned', 'plugin_version_changed', false, false);
  }
  if (!voiceModelPackArtifactBindingsEqualV1(params.source.artifactBinding, params.metadata.artifactBinding)) {
    return decision('orphaned', 'artifact_binding_changed', false, false);
  }
  if (params.source.packVersion !== params.metadata.packVersion) {
    return decision('orphaned', 'pack_version_changed', false, false);
  }
  if (!voiceModelPackSha256DigestsEqualV1(params.source.manifestDigest, params.metadata.manifestDigest)) {
    return decision('quarantined', 'manifest_digest_changed', false, false);
  }
  return decision('active', null, true, true);
}
