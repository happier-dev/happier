import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  buildQualifiedPluginContributionKey,
  parseModelPackManifest,
  type ModelPackManifest,
  type VoiceModelPackIdentityV1,
  type VoiceModelPackRuntimeV1,
  type VoiceModelPackSupportArtifactV1,
} from '@happier-dev/protocol';
import {
  buildVoiceModelPackInstallUrlPolicyV1,
  deriveVoiceModelPackManifestDigestV1,
  deriveVoiceModelPackLicenseTextDigestV1,
  installModelPackWithHost,
  verifyInstalledModelPackWithHost,
  voiceModelPackArtifactBindingsEqualV1,
  voiceModelPackSha256DigestsEqualV1,
  type EffectiveVoiceModelPackDescriptorV1,
  type InstalledVoiceModelPackMetadataV1,
  type ModelPackCoreProgress,
  type ModelPackInstallerHost,
  type ModelPackUrlPolicy,
  type VoiceModelPackHostCapabilitiesV1,
  type VoiceModelPackArtifactBindingV1,
} from '@happier-dev/voice-modelpacks';

import packageJson from '../../../../package.json';
import { readInstalledPluginCatalogSnapshot } from '@/plugins/projection/catalog/installed';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';
import {
  clearModelPackPromotionIntent,
  createNodeModelPackInstallerHost,
  inspectModelPackPromotionTopology,
  readModelPackPromotionIntents,
  reconcileModelPackPromotions,
  settleModelPackPromotion,
} from '../modelPackInstallerHost.node';
import { createNodeInstalledModelPackIntegrityHost } from '../modelPackIntegrityHost.node';
import {
  readInstalledVoiceModelPackManifest,
  removeInstalledVoiceModelPack,
} from '../voiceModelPackInstaller';
import { createVoiceInferenceError } from '../voiceInferenceWorker.shared';
import type { VoiceInferencePaths } from '../voiceInferencePaths';
import {
  projectInstalledDaemonPluginVoiceModelPackCatalogV1,
  type DaemonVoiceModelPackCatalogEntryV1,
} from '../pluginModelPackCatalog';
import {
  createDaemonPublicVoiceModelPackStateStore,
  parseInstalledVoiceModelPackMetadataV1,
} from './state';

const PUBLIC_PACK_RECOVERY_KIND = 'daemon_public_voice_model_pack_state_v1';

type InstallProgress = Readonly<{
  phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'error';
  progress: number;
  bytesDownloaded?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}>;

export type DaemonPublicVoiceModelPackEntry = Readonly<{
  key: string;
  identity: VoiceModelPackIdentityV1;
  directoryKey: string;
  descriptor: DaemonVoiceModelPackCatalogEntryV1 | null;
  installedMetadata: InstalledVoiceModelPackMetadataV1 | null;
  installedManifest: ModelPackManifest | null;
  runtimeDescriptor: VoiceModelPackRuntimeV1 | null;
  supportArtifacts: readonly VoiceModelPackSupportArtifactV1[];
}>;

export type DaemonPublicVoiceModelPackRuntime = Readonly<{
  ready(): Promise<void>;
  list(): Promise<readonly DaemonPublicVoiceModelPackEntry[]>;
  resolve(key: string): Promise<DaemonPublicVoiceModelPackEntry | null>;
  install(input: Readonly<{
    key: string;
    signal: AbortSignal;
    reportProgress?: (progress: InstallProgress) => Promise<void> | void;
  }>): Promise<DaemonPublicVoiceModelPackEntry>;
  acceptLicense(input: Readonly<{
    qualifiedPackId: string;
    pluginId: string;
    packId: string;
    pluginVersion: string;
    packVersion: string;
    licenseId: string;
    licenseSourceUrl: string;
    licenseTextDigest: string;
    artifactBinding: VoiceModelPackArtifactBindingV1;
  }>): Promise<DaemonPublicVoiceModelPackEntry>;
  remove(key: string): Promise<void>;
}>;

type PublicPackInstallerHostInput = Readonly<{
  packsRootDir: string;
  urlPolicy: ModelPackUrlPolicy;
}>;

function buildLegacyManifest(descriptor: EffectiveVoiceModelPackDescriptorV1): ModelPackManifest {
  if (!descriptor.contribution || !descriptor.directoryKey) throw new Error('voice_model_pack_descriptor_invalid');
  const manifest = descriptor.contribution.manifest;
  return parseModelPackManifest({
    packId: descriptor.directoryKey,
    kind: manifest.kind,
    model: manifest.model,
    version: manifest.version,
    ...(manifest.voices ? { voices: manifest.voices } : {}),
    files: manifest.files,
  });
}

function scopeStateFilePath(paths: VoiceInferencePaths, accountId: string, machineId: string): string {
  const digest = createHash('sha256')
    .update('happier.voice.public-model-packs.scope.v1\0')
    .update(accountId)
    .update('\0')
    .update(machineId)
    .digest('hex');
  return join(paths.rootDir, 'public-model-packs', `scope-${digest}.v1.json`);
}

export function resolveDefaultDaemonVoiceModelPackHostCapabilities(
  platform: NodeJS.Platform,
  architecture: string,
): VoiceModelPackHostCapabilitiesV1 | null {
  const supportsOwnedRuntime = (
    ((platform === 'darwin' || platform === 'linux') && (architecture === 'arm64' || architecture === 'x64'))
    || (platform === 'win32' && architecture === 'x64')
  );
  if (!supportsOwnedRuntime) return null;
  return {
    executionHost: 'daemon',
    hostVersion: packageJson.version,
    platform: platform as 'darwin' | 'linux' | 'win32',
    architecture: architecture as 'arm64' | 'x64',
    runtimeFamilies: {
      sherpa_zipformer_streaming: { abiVersion: 1 },
      sherpa_kokoro_offline: { abiVersion: 1 },
    },
  };
}

function defaultHostCapabilities(): VoiceModelPackHostCapabilitiesV1 | null {
  return resolveDefaultDaemonVoiceModelPackHostCapabilities(process.platform, process.arch);
}

export function createDaemonPublicVoiceModelPackRuntime(params: Readonly<{
  accountId: string;
  machineId: string;
  happyHomeDir: string;
  paths: VoiceInferencePaths;
  host?: VoiceModelPackHostCapabilitiesV1;
  /** Test/system boundary for network + filesystem effects; orchestration stays canonical. */
  createInstallerHost?: (input: PublicPackInstallerHostInput) => ModelPackInstallerHost;
  /** Persistence-path boundary for isolated integration tests. */
  stateFilePath?: string;
  now?: () => number;
  /** Test boundary for proving cache invalidation independently of filesystem stat changes. */
  fingerprintInstalledPack?: (packId: string, filePaths: readonly string[]) => Promise<string>;
  /** Applied daemon-runtime policy boundary. Tests may inject exact admission facts. */
  readPluginFinalPolicyCurrentGenerations?: () => Promise<ReadonlyMap<string, PluginFinalPolicyCurrentGeneration> | null>;
}>): DaemonPublicVoiceModelPackRuntime {
  const state = createDaemonPublicVoiceModelPackStateStore({
    stateFilePath: params.stateFilePath ?? scopeStateFilePath(params.paths, params.accountId, params.machineId),
    accountId: params.accountId,
    machineId: params.machineId,
  });
  const host = params.host ?? defaultHostCapabilities();
  const now = params.now ?? Date.now;
  const integrityHost = createNodeInstalledModelPackIntegrityHost(params.paths.packsRootDir);
  const verifiedInstallKeys = new Set<string>();
  const verifiedPhysicalFingerprints = new Map<string, string>();
  let reconciliation: Promise<void> | null = null;
  let admittedRegistryRevision: number | null = null;

  const metadataEqual = (
    left: InstalledVoiceModelPackMetadataV1 | null,
    right: InstalledVoiceModelPackMetadataV1 | null,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);

  const verificationKeyFor = (metadata: InstalledVoiceModelPackMetadataV1): string => JSON.stringify([
    metadata.identity.pluginId,
    metadata.identity.packId,
    metadata.artifactBinding,
    metadata.manifestDigest,
    metadata.verifiedAtMs,
  ]);
  const promotionScopeKey = JSON.stringify([params.accountId, params.machineId]);
  const promotionIdentityKey = (metadata: InstalledVoiceModelPackMetadataV1): string => JSON.stringify([
    metadata.identity.pluginId,
    metadata.identity.packId,
  ]);

  async function reconcilePendingPromotions(): Promise<void> {
    await reconcileModelPackPromotions(params.paths.packsRootDir);
    const intents = await readModelPackPromotionIntents(params.paths.packsRootDir);
    for (const intent of intents) {
      if (intent.recovery?.kind !== PUBLIC_PACK_RECOVERY_KIND) {
        throw new Error('voice_model_pack_promotion_recovery_owner_unknown');
      }
      const raw = intent.recovery.value;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('voice_model_pack_promotion_recovery_invalid');
      }
      const record = raw as Readonly<Record<string, unknown>>;
      if (typeof record.accountId !== 'string' || typeof record.machineId !== 'string') {
        throw new Error('voice_model_pack_promotion_recovery_invalid');
      }
      if (record.accountId !== params.accountId || record.machineId !== params.machineId) {
        throw new Error('voice_model_pack_promotion_scope_mismatch');
      }
      let before: InstalledVoiceModelPackMetadataV1 | null;
      let after: InstalledVoiceModelPackMetadataV1;
      try {
        before = record.before === null ? null : parseInstalledVoiceModelPackMetadataV1(record.before);
        after = parseInstalledVoiceModelPackMetadataV1(record.after);
      } catch {
        throw new Error('voice_model_pack_promotion_recovery_invalid');
      }
      if (after.directoryKey !== intent.packId || (before && before.directoryKey !== intent.packId)) {
        throw new Error('voice_model_pack_promotion_recovery_invalid');
      }
      if (
        (before === null && intent.priorInstall !== null)
        || (before !== null && (
          intent.priorInstall?.scopeKey !== promotionScopeKey
          || intent.priorInstall.identityKey !== promotionIdentityKey(before)
          || promotionIdentityKey(before) !== promotionIdentityKey(after)
        ))
      ) {
        throw new Error('voice_model_pack_promotion_recovery_invalid');
      }
      const currentState = await state.read();
      const current = currentState.installed.find((candidate) => (
        candidate.identity.pluginId === after.identity.pluginId
        && candidate.identity.packId === after.identity.packId
      )) ?? null;
      let outcome: 'commit' | 'rollback';
      if (intent.phase === 'metadata_committed') {
        if (metadataEqual(current, after)) outcome = 'commit';
        else if (metadataEqual(current, before)) outcome = 'rollback';
        else throw new Error('voice_model_pack_promotion_state_diverged');
      } else if (intent.phase === 'rollback_pending' || intent.phase === 'swap_prepared') {
        if (!metadataEqual(current, after) && !metadataEqual(current, before)) {
          throw new Error('voice_model_pack_promotion_state_diverged');
        }
        outcome = 'rollback';
      }
      else if (metadataEqual(current, after)) outcome = 'commit';
      else if (metadataEqual(current, before)) outcome = 'rollback';
      else throw new Error('voice_model_pack_promotion_state_diverged');

      const topology = await inspectModelPackPromotionTopology(params.paths.packsRootDir, intent.packId);
      if (outcome === 'rollback' && intent.priorInstall && !topology.liveExists && !topology.backupExists) {
        throw new Error('model_pack_promotion_prior_missing');
      }
      if (outcome === 'commit' && !topology.liveExists) {
        if (before && topology.backupExists) outcome = 'rollback';
        else throw new Error('voice_model_pack_promotion_live_missing');
      }

      if (outcome === 'commit') {
        if (!metadataEqual(current, after)) await state.recordInstalled(after);
        await settleModelPackPromotion({
          packsRootDir: params.paths.packsRootDir,
          packId: intent.packId,
          outcome: 'commit',
        });
      } else {
        await settleModelPackPromotion({
          packsRootDir: params.paths.packsRootDir,
          packId: intent.packId,
          outcome: 'rollback',
          clearIntent: false,
          priorInstall: intent.priorInstall,
        });
        if (before) await state.recordInstalled(before);
        else await state.removeInstalled(after.identity);
        await clearModelPackPromotionIntent(params.paths.packsRootDir, intent.packId);
      }
    }
  }

  function ready(): Promise<void> {
    reconciliation ??= reconcilePendingPromotions().finally(() => {
      reconciliation = null;
    });
    return reconciliation;
  }

  async function readVerifiedInstalledManifest(input: Readonly<{
    descriptor: DaemonVoiceModelPackCatalogEntryV1;
    metadata: InstalledVoiceModelPackMetadataV1;
  }>): Promise<ModelPackManifest | null> {
    const actualManifest = await readInstalledVoiceModelPackManifest({
      packsRootDir: params.paths.packsRootDir,
      packId: input.metadata.directoryKey,
    });
    if (!actualManifest) return null;
    const verificationKey = verificationKeyFor(input.metadata);
    let physicalFingerprint: string;
    try {
      physicalFingerprint = await (params.fingerprintInstalledPack ?? integrityHost.fingerprint)(
        input.metadata.directoryKey,
        actualManifest.files.map((file) => file.path),
      );
    } catch {
      return null;
    }
    if (
      !verifiedInstallKeys.has(verificationKey)
      || verifiedPhysicalFingerprints.get(verificationKey) !== physicalFingerprint
    ) {
      try {
        await verifyInstalledModelPackWithHost({
          host: integrityHost,
          packId: input.metadata.directoryKey,
          expectedManifest: buildLegacyManifest(input.descriptor),
          actualManifest,
        });
      } catch {
        return null;
      }
      verifiedInstallKeys.add(verificationKey);
      verifiedPhysicalFingerprints.set(verificationKey, physicalFingerprint);
    }
    return actualManifest;
  }

  async function project(): Promise<readonly DaemonPublicVoiceModelPackEntry[]> {
    await ready();
    const durable = await state.read();
    const pluginCatalog = await readInstalledPluginCatalogSnapshot({ happyHomeDir: params.happyHomeDir });
    if (admittedRegistryRevision !== null && admittedRegistryRevision !== pluginCatalog.revision) {
      // A registry revision can include an unobserved disable/orphan/re-enable
      // interval. A new revision therefore starts a fresh verification epoch;
      // stat identity is not evidence that bytes stayed admitted throughout.
      verifiedInstallKeys.clear();
      verifiedPhysicalFingerprints.clear();
    }
    admittedRegistryRevision = pluginCatalog.revision;
    let descriptors: readonly DaemonVoiceModelPackCatalogEntryV1[] = [];
    if (host) {
      const injectedPolicy = params.readPluginFinalPolicyCurrentGenerations
        ? await params.readPluginFinalPolicyCurrentGenerations()
        : undefined;
      const lease = injectedPolicy === undefined
        ? pluginReloadController.tryAcquireRuntimeRegistry?.() ?? null
        : null;
      const currentPluginGenerations = injectedPolicy
        ?? lease?.registry.pluginFinalPolicyCurrentGenerationsById
        ?? null;
      if (currentPluginGenerations) {
        try {
          descriptors = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
            installedPlugins: pluginCatalog.entries,
            currentPluginGenerations,
            host,
            acceptedLicenses: durable.licenseAcceptances,
            licenseScope: {
              accountId: params.accountId,
              executionHost: 'daemon',
              hostId: params.machineId,
            },
            installedMetadata: durable.installed,
          });
        } finally {
          await lease?.release();
        }
      }
    }
    const entries: DaemonPublicVoiceModelPackEntry[] = [];
    const activeIdentityKeys = new Set<string>();
    for (const descriptor of descriptors) {
      if (!descriptor.identity || !descriptor.directoryKey || !descriptor.contribution) continue;
      const identityKey = JSON.stringify([descriptor.identity.pluginId, descriptor.identity.packId]);
      activeIdentityKeys.add(identityKey);
      const installedMetadata = durable.installed.find((candidate) => (
        candidate.identity.pluginId === descriptor.identity?.pluginId
        && candidate.identity.packId === descriptor.identity?.packId
      )) ?? null;
      if (installedMetadata && !descriptor.loadable) {
        // A disabled/orphaned/quarantined lifecycle ends the admitted cache
        // epoch. Reclaim must rehash physical bytes even when metadata is equal.
        verifiedInstallKeys.delete(verificationKeyFor(installedMetadata));
        verifiedPhysicalFingerprints.delete(verificationKeyFor(installedMetadata));
      }
      entries.push(Object.freeze({
        key: buildQualifiedPluginContributionKey({
          pluginId: descriptor.identity.pluginId,
          localId: descriptor.identity.packId,
        }),
        identity: descriptor.identity,
        directoryKey: descriptor.directoryKey,
        descriptor,
        installedMetadata,
        installedManifest: installedMetadata
          ? descriptor.loadable
            ? await readVerifiedInstalledManifest({ descriptor, metadata: installedMetadata })
            : await readInstalledVoiceModelPackManifest({
                packsRootDir: params.paths.packsRootDir,
                packId: installedMetadata.directoryKey,
              })
          : null,
        runtimeDescriptor: descriptor.contribution.manifest.runtime,
        supportArtifacts: Object.freeze([...(descriptor.contribution.manifest.supportArtifacts ?? [])]),
      }));
    }
    for (const metadata of durable.installed) {
      const identityKey = JSON.stringify([metadata.identity.pluginId, metadata.identity.packId]);
      if (activeIdentityKeys.has(identityKey)) continue;
      entries.push(Object.freeze({
        key: buildQualifiedPluginContributionKey({
          pluginId: metadata.identity.pluginId,
          localId: metadata.identity.packId,
        }),
        identity: metadata.identity,
        directoryKey: metadata.directoryKey,
        descriptor: null,
        installedMetadata: metadata,
        installedManifest: await readInstalledVoiceModelPackManifest({
          packsRootDir: params.paths.packsRootDir,
          packId: metadata.directoryKey,
        }),
        runtimeDescriptor: null,
        supportArtifacts: Object.freeze([]),
      }));
    }
    for (const cleanupOnly of durable.unboundInstalled) {
      const identityKey = JSON.stringify([
        cleanupOnly.identity.pluginId,
        cleanupOnly.identity.packId,
      ]);
      if (activeIdentityKeys.has(identityKey)) continue;
      entries.push(Object.freeze({
        key: buildQualifiedPluginContributionKey({
          pluginId: cleanupOnly.identity.pluginId,
          localId: cleanupOnly.identity.packId,
        }),
        identity: cleanupOnly.identity,
        directoryKey: cleanupOnly.directoryKey,
        descriptor: null,
        installedMetadata: null,
        installedManifest: null,
        runtimeDescriptor: null,
        supportArtifacts: Object.freeze([]),
      }));
    }
    return Object.freeze(entries.sort((left, right) => left.key.localeCompare(right.key)));
  }

  const resolve = async (key: string): Promise<DaemonPublicVoiceModelPackEntry | null> => (
    (await project()).find((entry) => entry.key === key) ?? null
  );

  return Object.freeze({
    ready,
    list: project,
    resolve,
    acceptLicense: async (input) => {
      const entry = await resolve(input.qualifiedPackId);
      const descriptor = entry?.descriptor;
      const contribution = descriptor?.contribution;
      const license = contribution?.manifest.license;
      if (!entry || !descriptor || !contribution || !license?.requiresAcceptance || !license.text) {
        throw new Error('voice_model_pack_license_not_reviewable');
      }
      const exact = descriptor.identity?.pluginId === input.pluginId
        && descriptor.identity.packId === input.packId
        && descriptor.pluginVersion === input.pluginVersion
        && contribution.manifest.version === input.packVersion
        && license.id === input.licenseId
        && license.url === input.licenseSourceUrl
        && voiceModelPackSha256DigestsEqualV1(
          deriveVoiceModelPackLicenseTextDigestV1(license.text),
          input.licenseTextDigest,
        )
        && voiceModelPackArtifactBindingsEqualV1(descriptor.artifactBinding, input.artifactBinding);
      if (!exact || !descriptor.identity) throw new Error('voice_model_pack_license_binding_changed');
      await state.acceptLicense({
        identity: descriptor.identity,
        packVersion: contribution.manifest.version,
        licenseId: license.id,
        licenseSourceUrl: license.url,
        licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(license.text),
        artifactBinding: descriptor.artifactBinding,
        acceptedAtMs: now(),
      });
      const accepted = await resolve(input.qualifiedPackId);
      if (!accepted) throw new Error('voice_model_pack_license_state_missing');
      return accepted;
    },
    install: async ({ key, signal, reportProgress }) => {
      const entry = await resolve(key);
      const descriptor = entry?.descriptor;
      if (!entry || !descriptor || !descriptor.installable || !descriptor.identity || !descriptor.directoryKey || !descriptor.contribution) {
        throw new Error('voice_model_pack_not_installable');
      }
      const manifest = buildLegacyManifest(descriptor);
      const metadata: InstalledVoiceModelPackMetadataV1 = {
        schemaVersion: 1,
        identity: descriptor.identity,
        directoryKey: descriptor.directoryKey,
        pluginVersion: descriptor.pluginVersion,
        artifactBinding: descriptor.artifactBinding,
        packVersion: descriptor.contribution.manifest.version,
        manifestDigest: deriveVoiceModelPackManifestDigestV1(descriptor.contribution.manifest),
        verifiedAtMs: now(),
      };
      const priorMetadata = entry.installedMetadata;
      const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      await reportProgress?.({ phase: 'downloading', progress: 0, bytesDownloaded: 0, totalBytes });
      const urlPolicy = buildVoiceModelPackInstallUrlPolicyV1(descriptor);
      const installerHost = params.createInstallerHost?.({
        packsRootDir: params.paths.packsRootDir,
        urlPolicy,
      }) ?? createNodeModelPackInstallerHost({
        packsRootDir: params.paths.packsRootDir,
        urlPolicy,
      });
      try {
        await installModelPackWithHost({
          host: installerHost,
          packId: manifest.packId,
          manifest,
          signal,
          urlPolicy,
          sourceBinding: {
            kind: 'plugin',
            pluginId: descriptor.identity.pluginId,
            packId: descriptor.identity.packId,
            pluginVersion: descriptor.pluginVersion,
            artifactBinding: descriptor.artifactBinding,
          },
          priorInstall: priorMetadata
            ? Object.freeze({
                scopeKey: promotionScopeKey,
                identityKey: promotionIdentityKey(priorMetadata),
              })
            : null,
          onProgress: (progress: ModelPackCoreProgress) => {
            void reportProgress?.({
              phase: 'downloading',
              progress: progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 1,
              bytesDownloaded: progress.loaded,
              totalBytes: progress.total,
            });
          },
          durableCommit: {
            recovery: {
              kind: PUBLIC_PACK_RECOVERY_KIND,
              value: {
                accountId: params.accountId,
                machineId: params.machineId,
                before: priorMetadata,
                after: metadata,
              },
            },
            commit: async () => {
              const current = await resolve(key);
              const currentDescriptor = current?.descriptor;
              if (
                !currentDescriptor?.installable
                || currentDescriptor.status !== 'available'
                || currentDescriptor.identity?.pluginId !== metadata.identity.pluginId
                || currentDescriptor.identity.packId !== metadata.identity.packId
                || currentDescriptor.pluginVersion !== metadata.pluginVersion
                || !voiceModelPackArtifactBindingsEqualV1(currentDescriptor.artifactBinding, metadata.artifactBinding)
                || !currentDescriptor.contribution
                || deriveVoiceModelPackManifestDigestV1(currentDescriptor.contribution.manifest) !== metadata.manifestDigest
              ) {
                throw new Error('voice_model_pack_source_stale');
              }
              await state.recordInstalled(metadata);
            },
            rollback: async () => {
              if (priorMetadata) await state.recordInstalled(priorMetadata);
              else await state.removeInstalled(descriptor.identity);
            },
          },
        });
      } catch (error) {
        if (signal.aborted) throw createVoiceInferenceError('cancelled');
        throw error;
      }
      const installed = await resolve(key);
      if (!installed) throw new Error('voice_model_pack_install_state_missing');
      return installed;
    },
    remove: async (key) => {
      const entry = await resolve(key);
      if (!entry) return;
      await removeInstalledVoiceModelPack({
        packsRootDir: params.paths.packsRootDir,
        packId: entry.directoryKey,
      });
      await state.removeInstalled(entry.identity);
      verifiedInstallKeys.clear();
      verifiedPhysicalFingerprints.clear();
    },
  });
}
