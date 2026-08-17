import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import {
  VOICE_MODEL_PACK_CONTRIBUTION_MAX_COMPONENT_BYTES_V1,
  VoiceModelPackContributionV1Schema,
  VoiceModelPackIdentityV1Schema,
  resolveVoiceModelPackArtifactsV1,
  type PluginFinalPolicyDecision,
  type ModelPackRuntimeFamily,
  type VoiceModelPackContributionV1,
  type VoiceModelPackExecutionHostV1,
  type VoiceModelPackIdentityV1,
} from '@happier-dev/protocol';

import {
  DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1,
  assertVoiceModelPackDeclaredResourcesV1,
  type VoiceModelPackResourcePolicyV1,
} from './resourcePolicy.js';
import {
  parseVoiceModelPackArtifactBindingV1,
  voiceModelPackArtifactBindingsEqualV1,
  type VoiceModelPackArtifactBindingV1,
} from './artifactBinding.js';
import type { ModelPackUrlPolicy } from './urlPolicy.js';
import { voiceModelPackSha256DigestsEqualV1 } from './sha256Digest.js';

const IDENTITY_DOMAIN_V1 = utf8ToBytes('happier.voice.model-pack.v1\0');
const MANIFEST_DIGEST_DOMAIN_V1 = utf8ToBytes('happier.voice.model-pack.manifest.v1\0');
const INVALID_OWN_DATA_SNAPSHOT = Symbol('invalid_own_data_snapshot');

function snapshotOwnJsonData(
  value: unknown,
  activeAncestors: WeakSet<object> = new WeakSet(),
): unknown | typeof INVALID_OWN_DATA_SNAPSHOT {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_OWN_DATA_SNAPSHOT;
  if (typeof value !== 'object' || activeAncestors.has(value)) return INVALID_OWN_DATA_SNAPSHOT;

  activeAncestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return INVALID_OWN_DATA_SNAPSHOT;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : null;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
        return INVALID_OWN_DATA_SNAPSHOT;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some((key) => (
        typeof key !== 'string'
        || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
      ))) {
        return INVALID_OWN_DATA_SNAPSHOT;
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          return INVALID_OWN_DATA_SNAPSHOT;
        }
        const snapshot = snapshotOwnJsonData(descriptor.value, activeAncestors);
        if (snapshot === INVALID_OWN_DATA_SNAPSHOT) return INVALID_OWN_DATA_SNAPSHOT;
        result.push(snapshot);
      }
      return result;
    }

    if (prototype !== Object.prototype && prototype !== null) return INVALID_OWN_DATA_SNAPSHOT;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return INVALID_OWN_DATA_SNAPSHOT;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return INVALID_OWN_DATA_SNAPSHOT;
      }
      const snapshot = snapshotOwnJsonData(descriptor.value, activeAncestors);
      if (snapshot === INVALID_OWN_DATA_SNAPSHOT) return INVALID_OWN_DATA_SNAPSHOT;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: snapshot,
        writable: true,
      });
    }
    return result;
  } catch {
    return INVALID_OWN_DATA_SNAPSHOT;
  } finally {
    activeAncestors.delete(value);
  }
}

function readOwnDataProperty(
  value: unknown,
  key: string,
): Readonly<{ value: unknown }> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor
      ? Object.freeze({ value: descriptor.value })
      : null;
  } catch {
    return null;
  }
}

function readOwnStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : null;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    const indexKeys = Reflect.ownKeys(value).filter((key) => typeof key === 'string' && key !== 'length');
    if (indexKeys.length !== length) return null;
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

export type { VoiceModelPackIdentityV1 } from '@happier-dev/protocol';

export type InstalledPluginVoiceModelPackSourceV1 = Readonly<{
  pluginId: string;
  pluginVersion: string;
  artifactBinding: VoiceModelPackArtifactBindingV1;
  enabled: boolean;
  authorization: PluginFinalPolicyDecision;
  grantedNetworkOrigins: readonly string[];
}>;

export type VoiceModelPackHostCapabilitiesV1 = Readonly<{
  executionHost: VoiceModelPackExecutionHostV1;
  hostVersion: string;
  platform: 'darwin' | 'linux' | 'win32' | 'ios' | 'android';
  architecture: 'arm64' | 'x64';
  runtimeFamilies: Partial<Readonly<Record<ModelPackRuntimeFamily, Readonly<{ abiVersion: number }>>>>;
}>;

export type VoiceModelPackLicenseScopeV1 = Readonly<{
  accountId: string;
  executionHost: VoiceModelPackExecutionHostV1;
  hostId: string;
}>;

export type VoiceModelPackLicenseAcceptanceV1 = VoiceModelPackLicenseScopeV1 & Readonly<{
  pluginId: string;
  packId: string;
  packVersion: string;
  licenseId: string;
  licenseSourceUrl: string;
  licenseTextDigest: string;
  /** Exact source-integrity or local-materialization custody of the declared pack. */
  artifactBinding: VoiceModelPackArtifactBindingV1;
}>;

const LICENSE_TEXT_DIGEST_DOMAIN_V1 = utf8ToBytes('happier.voice.model-pack.license-text.v1\0');

export function deriveVoiceModelPackLicenseTextDigestV1(text: string): string {
  return `sha256:${bytesToHex(sha256(concatBytes(LICENSE_TEXT_DIGEST_DOMAIN_V1, utf8ToBytes(text)))).toLowerCase()}`;
}

type ParsedVoiceModelPackDescriptorV1 = Readonly<{
  status: 'available' | 'blocked' | 'incompatible' | 'orphaned';
  reason: string | null;
  identity: VoiceModelPackIdentityV1;
  directoryKey: string;
  pluginVersion: string;
  artifactBinding: VoiceModelPackArtifactBindingV1;
  grantedNetworkOrigins: readonly string[];
  contribution: VoiceModelPackContributionV1;
}>;

type RejectedRawVoiceModelPackDescriptorV1 = Readonly<{
  status: 'blocked';
  reason: 'artifact_mapping_invalid' | 'artifact_binding_invalid';
  identity: null;
  directoryKey: null;
  pluginVersion: string;
  artifactBinding: null;
  contribution: null;
}>;

export type EffectiveVoiceModelPackDescriptorV1 =
  | ParsedVoiceModelPackDescriptorV1
  | RejectedRawVoiceModelPackDescriptorV1;

function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('voice_model_pack_manifest_not_canonicalizable');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate !== 'undefined') output[key] = canonicalizeJsonValue(candidate);
    }
    return output;
  }
  throw new Error('voice_model_pack_manifest_not_canonicalizable');
}

/** Stable digest binding verified installed metadata to the exact admitted manifest. */
export function deriveVoiceModelPackManifestDigestV1(manifest: VoiceModelPackContributionV1['manifest']): string {
  const canonical = JSON.stringify(canonicalizeJsonValue(manifest));
  return `sha256:${bytesToHex(sha256(concatBytes(MANIFEST_DIGEST_DOMAIN_V1, utf8ToBytes(canonical)))).toLowerCase()}`;
}

function encodeLength(length: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, length, false);
  return result;
}

function encodeIdentityComponent(value: string): Uint8Array {
  const bytes = utf8ToBytes(value);
  if (bytes.byteLength > VOICE_MODEL_PACK_CONTRIBUTION_MAX_COMPONENT_BYTES_V1) {
    throw new Error('voice_model_pack_identity_component_too_large');
  }
  return concatBytes(encodeLength(bytes.byteLength), bytes);
}

/** Filesystem key only. Structured identity remains authoritative in persisted metadata. */
export function deriveVoiceModelPackDirectoryKeyV1(identity: VoiceModelPackIdentityV1): string {
  const digest = sha256(concatBytes(
    IDENTITY_DOMAIN_V1,
    encodeIdentityComponent(identity.pluginId),
    encodeIdentityComponent(identity.packId),
  ));
  return `vp-${bytesToHex(digest).toLowerCase()}`;
}

/** A theoretical digest collision must never cause one structured identity to load another. */
export function assertVoiceModelPackStoredIdentityV1(
  expected: VoiceModelPackIdentityV1,
  stored: VoiceModelPackIdentityV1,
): void {
  if (expected.pluginId !== stored.pluginId || expected.packId !== stored.packId) {
    throw new Error('voice_model_pack_directory_identity_mismatch');
  }
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): readonly [number, number, number, string | null] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(value);
    if (!match) return [-1, -1, -1, null];
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] as number;
    const rightPart = b[index] as number;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  const leftIdentifiers = a[3].split('.');
  const rightIdentifiers = b[3].split('.');
  const count = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < count; index += 1) {
    const leftId = leftIdentifiers[index];
    const rightId = rightIdentifiers[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      const leftNormalized = leftId.replace(/^0+(?=\d)/, '');
      const rightNormalized = rightId.replace(/^0+(?=\d)/, '');
      if (leftNormalized.length !== rightNormalized.length) {
        return leftNormalized.length - rightNormalized.length;
      }
      return leftNormalized < rightNormalized ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

function normalizeGrantedOrigins(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.flatMap((raw) => {
    if (raw.trim() === '*') return ['*'];
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password ? [url.origin] : [];
    } catch {
      return [];
    }
  }));
}

function allDeclaredOriginsGranted(
  contribution: VoiceModelPackContributionV1,
  grantedOrigins: readonly string[],
): boolean {
  const granted = normalizeGrantedOrigins(grantedOrigins);
  if (granted.has('*')) return true;
  const urls = [
    contribution.manifest.provenance.source,
    contribution.manifest.license.url,
    ...contribution.manifest.files.map((file) => file.url),
  ];
  return urls.every((raw) => granted.has(new URL(raw).origin));
}

function licenseAccepted(
  identity: VoiceModelPackIdentityV1,
  contribution: VoiceModelPackContributionV1,
  artifactBinding: VoiceModelPackArtifactBindingV1,
  scope: VoiceModelPackLicenseScopeV1 | undefined,
  acceptance: VoiceModelPackLicenseAcceptanceV1 | undefined,
): boolean {
  if (!contribution.manifest.license.requiresAcceptance) return true;
  if (!scope || !acceptance) return false;
  const scopeAccountId = readOwnDataProperty(scope, 'accountId')?.value;
  const scopeExecutionHost = readOwnDataProperty(scope, 'executionHost')?.value;
  const scopeHostId = readOwnDataProperty(scope, 'hostId')?.value;
  const acceptedAccountId = readOwnDataProperty(acceptance, 'accountId')?.value;
  const acceptedExecutionHost = readOwnDataProperty(acceptance, 'executionHost')?.value;
  const acceptedHostId = readOwnDataProperty(acceptance, 'hostId')?.value;
  const acceptedPluginId = readOwnDataProperty(acceptance, 'pluginId')?.value;
  const acceptedPackId = readOwnDataProperty(acceptance, 'packId')?.value;
  const acceptedPackVersion = readOwnDataProperty(acceptance, 'packVersion')?.value;
  const acceptedLicenseId = readOwnDataProperty(acceptance, 'licenseId')?.value;
  const acceptedLicenseSourceUrl = readOwnDataProperty(acceptance, 'licenseSourceUrl')?.value;
  const acceptedLicenseTextDigest = readOwnDataProperty(acceptance, 'licenseTextDigest')?.value;
  const acceptedArtifactBinding = readOwnDataProperty(acceptance, 'artifactBinding')?.value;
  const licenseText = contribution.manifest.license.text;
  let parsedAcceptedArtifactBinding: VoiceModelPackArtifactBindingV1;
  try {
    parsedAcceptedArtifactBinding = parseVoiceModelPackArtifactBindingV1(acceptedArtifactBinding);
  } catch {
    return false;
  }
  return typeof scopeAccountId === 'string'
    && (scopeExecutionHost === 'daemon' || scopeExecutionHost === 'native_device')
    && typeof scopeHostId === 'string'
    && acceptedAccountId === scopeAccountId
    && acceptedExecutionHost === scopeExecutionHost
    && acceptedHostId === scopeHostId
    && acceptedPluginId === identity.pluginId
    && acceptedPackId === identity.packId
    && acceptedPackVersion === contribution.manifest.version
    && acceptedLicenseId === contribution.manifest.license.id
    && acceptedLicenseSourceUrl === contribution.manifest.license.url
    && typeof licenseText === 'string'
    && typeof acceptedLicenseTextDigest === 'string'
    && voiceModelPackSha256DigestsEqualV1(
      acceptedLicenseTextDigest,
      deriveVoiceModelPackLicenseTextDigestV1(licenseText),
    )
    && voiceModelPackArtifactBindingsEqualV1(parsedAcceptedArtifactBinding, artifactBinding);
}

export function admitVoiceModelPackContributionV1(params: Readonly<{
  source: InstalledPluginVoiceModelPackSourceV1;
  contribution: VoiceModelPackContributionV1;
  host: VoiceModelPackHostCapabilitiesV1;
  licenseScope?: VoiceModelPackLicenseScopeV1;
  acceptedLicense?: VoiceModelPackLicenseAcceptanceV1;
  resourcePolicy?: VoiceModelPackResourcePolicyV1;
}>): EffectiveVoiceModelPackDescriptorV1 {
  const pluginVersionProperty = readOwnDataProperty(params.source, 'pluginVersion');
  const pluginVersion = typeof pluginVersionProperty?.value === 'string'
    ? pluginVersionProperty.value
    : '';
  const rejectedRaw = (
    reason: RejectedRawVoiceModelPackDescriptorV1['reason'],
  ): RejectedRawVoiceModelPackDescriptorV1 => Object.freeze({
    status: 'blocked',
    reason,
    identity: null,
    directoryKey: null,
    pluginVersion: pluginVersion.slice(0, 128),
    artifactBinding: null,
    contribution: null,
  });
  if (typeof pluginVersionProperty?.value !== 'string'
    || pluginVersion.length === 0
    || pluginVersion.length > 128) {
    return rejectedRaw('artifact_mapping_invalid');
  }
  const contributionSnapshot = snapshotOwnJsonData(params.contribution);
  if (contributionSnapshot === INVALID_OWN_DATA_SNAPSHOT) return rejectedRaw('artifact_mapping_invalid');
  let parsedContribution: ReturnType<typeof VoiceModelPackContributionV1Schema.safeParse>;
  try {
    parsedContribution = VoiceModelPackContributionV1Schema.safeParse(contributionSnapshot);
  } catch {
    return rejectedRaw('artifact_mapping_invalid');
  }
  if (!parsedContribution.success) return rejectedRaw('artifact_mapping_invalid');
  const artifactBindingProperty = readOwnDataProperty(params.source, 'artifactBinding');
  let artifactBinding: VoiceModelPackArtifactBindingV1;
  try {
    artifactBinding = parseVoiceModelPackArtifactBindingV1(artifactBindingProperty?.value);
  } catch {
    return rejectedRaw('artifact_binding_invalid');
  }

  const enabledProperty = readOwnDataProperty(params.source, 'enabled');
  const authorizationProperty = readOwnDataProperty(params.source, 'authorization');
  const authorizationOutcome = readOwnDataProperty(authorizationProperty?.value, 'outcome')?.value;
  const authorizationCode = readOwnDataProperty(authorizationProperty?.value, 'code')?.value;
  const authorizationRequiresCurrentIntent = readOwnDataProperty(
    authorizationProperty?.value,
    'requiresCurrentIntent',
  )?.value;
  const grantedNetworkOriginsProperty = readOwnDataProperty(params.source, 'grantedNetworkOrigins');
  const grantedNetworkOrigins = readOwnStringArray(grantedNetworkOriginsProperty?.value);
  if (typeof enabledProperty?.value !== 'boolean'
    || !['visible', 'disabled', 'denied', 'unavailable'].includes(String(authorizationOutcome))
    || typeof authorizationCode !== 'string'
    || typeof authorizationRequiresCurrentIntent !== 'boolean'
    || !grantedNetworkOrigins) {
    return rejectedRaw('artifact_mapping_invalid');
  }

  const contribution = parsedContribution.data;
  const pluginIdProperty = readOwnDataProperty(params.source, 'pluginId');
  const parsedIdentity = VoiceModelPackIdentityV1Schema.safeParse({
    pluginId: pluginIdProperty?.value,
    packId: contribution.id,
  });
  if (!parsedIdentity.success) return rejectedRaw('artifact_mapping_invalid');
  const identity = Object.freeze(parsedIdentity.data);
  const common = {
    identity,
    directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
    pluginVersion,
    artifactBinding,
    grantedNetworkOrigins: Object.freeze([...new Set(grantedNetworkOrigins)].sort()),
    contribution,
  } as const;
  const result = (
    status: EffectiveVoiceModelPackDescriptorV1['status'],
    reason: string | null,
  ): EffectiveVoiceModelPackDescriptorV1 => Object.freeze({ status, reason, ...common });

  if (!enabledProperty.value) return result('orphaned', 'plugin_disabled');
  if (authorizationOutcome !== 'visible') return result('blocked', 'plugin_policy_denied');

  const manifest = contribution.manifest;
  try {
    resolveVoiceModelPackArtifactsV1(manifest.runtime, manifest.files, manifest.supportArtifacts);
  } catch {
    return result('blocked', 'artifact_mapping_invalid');
  }
  if (!allDeclaredOriginsGranted(contribution, grantedNetworkOrigins)) {
    return result('blocked', 'network_origin_not_granted');
  }
  const policy = params.resourcePolicy ?? DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1;
  try {
    assertVoiceModelPackDeclaredResourcesV1(manifest.files, policy);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'model_pack_file_count_limit_exceeded') return result('blocked', 'file_count_limit_exceeded');
    if (code === 'model_pack_file_size_limit_exceeded') return result('blocked', 'file_size_limit_exceeded');
    return result('blocked', 'total_size_limit_exceeded');
  }
  // F34 has a consumed daemon execution vertical only. A contribution must not
  // advertise native-device support until a native host can prove the same
  // install, consent, lifecycle, and inference contract end to end.
  if (contribution.executionHosts.includes('native_device')) {
    return result('incompatible', 'declared_execution_host_unsupported');
  }
  if (!licenseAccepted(
    identity,
    contribution,
    common.artifactBinding,
    params.licenseScope,
    params.acceptedLicense,
  )) {
    return result('blocked', 'license_acceptance_required');
  }

  if (!contribution.executionHosts.includes(params.host.executionHost)) {
    return result('incompatible', 'execution_host_unsupported');
  }
  if (compareSemver(params.host.hostVersion, manifest.runtime.minHostVersion) < 0) {
    return result('incompatible', 'host_version_too_old');
  }
  if (!manifest.runtime.platforms.includes(params.host.platform)) {
    return result('incompatible', 'platform_unsupported');
  }
  if (!manifest.runtime.architectures.includes(params.host.architecture)) {
    return result('incompatible', 'architecture_unsupported');
  }
  const runtime = params.host.runtimeFamilies[manifest.runtime.family];
  if (!runtime) return result('incompatible', 'runtime_family_unsupported');
  if (runtime.abiVersion !== manifest.runtime.abiVersion) return result('incompatible', 'runtime_abi_mismatch');
  return result('available', null);
}

/** Redirect/DNS policy derived from an already-admitted immutable descriptor. */
export function buildVoiceModelPackInstallUrlPolicyV1(
  descriptor: EffectiveVoiceModelPackDescriptorV1,
): ModelPackUrlPolicy {
  if (descriptor.status !== 'available') throw new Error('voice_model_pack_not_installable');
  const allowedOrigins = descriptor.grantedNetworkOrigins;
  return Object.freeze({ allowedOrigins, requireResolvedAddresses: true });
}
