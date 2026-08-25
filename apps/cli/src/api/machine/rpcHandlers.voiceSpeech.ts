import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES as VOICE_SPEECH_INPUT_MAX_BYTES,
  DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES as VOICE_SPEECH_OUTPUT_MAX_BYTES,
  DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES as VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES,
  DaemonVoiceSpeechCatalogRequestSchema,
  DaemonVoiceSpeechSettingsActionRequestSchema,
  DaemonVoiceSpeechSettingsActionResponseSchema,
  DaemonVoiceSpeechDownloadAbortRequestSchema,
  DaemonVoiceSpeechDownloadAbortResponseSchema,
  DaemonVoiceSpeechDownloadChunkRequestSchema,
  DaemonVoiceSpeechDownloadChunkResponseSchema,
  DaemonVoiceSpeechDownloadFinalizeRequestSchema,
  DaemonVoiceSpeechDownloadFinalizeResponseSchema,
  DaemonVoiceSpeechSynthesizeRequestSchema,
  DaemonVoiceSpeechSynthesizeResponseSchema,
  DaemonVoiceSpeechTranscribeUploadAbortRequestSchema,
  DaemonVoiceSpeechTranscribeUploadAbortResponseSchema,
  DaemonVoiceSpeechTranscribeUploadChunkRequestSchema,
  DaemonVoiceSpeechTranscribeUploadChunkResponseSchema,
  DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema,
  DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceSpeechTranscribeUploadInitRequestSchema,
  DaemonVoiceSpeechTranscribeUploadInitResponseSchema,
  DaemonVoiceSpeechTranscribeRequestSchema,
  DaemonVoiceSpeechTranscribeResponseSchema,
  VoiceProviderCatalogResponseSchema,
  VoiceProviderSettingsEnvelopeV1Schema,
  buildQualifiedPluginContributionKey,
  resolveAccountSettingsVoiceCredentialSource,
  resolveVoiceSpeechSettingsCorrespondence,
  resolveVoiceSpeechEndpointPolicy,
  type VoiceCredentialAccessPhase,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';

import { configuration } from '@/configuration';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import {
  createTransferRecipientKeyPair,
  parseTransferRecipientPublicKeyBase64,
} from '@/machines/transfer/transferChunkEncryption';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import {
  createVoiceAccountOperationService,
  declaresAdmittedMediatedOperations,
} from '@/plugins/runtime/fetch/voiceAccountCredentialBinding';
import {
  createDaemonPluginRawCredentialMaterializer,
} from '@/plugins/runtime/credentials/daemonRawCredentialMaterializer';
import {
  createInvocationVoiceRawCredentialAccess,
  type CurrentPluginInstallReviewPrincipalReader,
  type CurrentPluginPermissionGrantAuthoritySourceReader,
  type PluginRawCredentialMaterializer,
  type PluginPermissionGrantListReader,
} from '@/plugins/runtime/credentials/rawCredentialMaterializer';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import type { RegisteredSpeechProviderRuntime } from '@/plugins/runtime/lifecycle/contributions/targetVoiceSpeech';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

type VoiceSpeechTargetRef = Readonly<{ pluginId: string; localId: string }>;
type UploadMetadata = Readonly<{
  target: VoiceSpeechTargetRef;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}>;
type FinalizedUpload = Readonly<UploadMetadata & { path: string }>;

type VoiceSpeechCredentialPhase = Extract<VoiceCredentialAccessPhase, 'settings' | 'speech'>;
type VoiceSpeechCredentialAccess = VoiceCredentialAccess<'settings'> | VoiceCredentialAccess<'speech'>;
const VOICE_SPEECH_CREDENTIAL_PHASES = Object.freeze<readonly VoiceSpeechCredentialPhase[]>(['settings', 'speech']);

function unavailableSpeechCredentials(phase: VoiceSpeechCredentialPhase): VoiceSpeechCredentialAccess {
  return Object.freeze({ phase, mediated: null, raw: null });
}

const invalid = Object.freeze({ ok: false as const, errorCode: 'invalid_parameters' as const });
const transferInvalid = Object.freeze({ success: false as const, error: 'invalid_parameters' as const, errorCode: 'invalid_parameters' as const });
function transferFailure(code: 'transfer_not_found' | 'transfer_failed' | 'cancelled') {
  return Object.freeze({ success: false as const, error: code, errorCode: code });
}

export type MachineVoiceSpeechRpcRegistration = Readonly<{ dispose(): Promise<void> }>;

export type VoiceSpeechRuntimeLease = Readonly<{
  runtime: RegisteredSpeechProviderRuntime;
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  readSettings(): Readonly<{
    settings: unknown;
    resolveCredentials(
      settings: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
      phase?: VoiceSpeechCredentialPhase,
      bindCredentialAuthorityCurrent?: (isCurrent: () => boolean) => void,
    ): VoiceSpeechCredentialAccess;
    isCurrent(): boolean;
  }>;
  createHttp(
    signal: AbortSignal,
    isOperationCurrent?: () => boolean,
    endpointPolicy?: import('@happier-dev/protocol').VoiceSpeechEndpointPolicy | null,
  ): Pick<HttpService, 'request'>;
  isCurrent(): boolean;
  retirementSignal: AbortSignal;
  release(): Promise<void>;
}>;

type RawCredentialDependencies = Readonly<{
  credentials?: StoredCredentials;
  currentInstallReviewPrincipal?: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource?: CurrentPluginPermissionGrantAuthoritySourceReader;
  grants?: PluginPermissionGrantListReader;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>;

function credentialUnavailable(): Error & { code: 'credential_unavailable' } {
  return Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' as const });
}

function isSpeechSettingsSnapshotCurrent(input: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  snapshotLifetimeToken: number;
  readSnapshot: () => ActiveAccountSettingsSnapshot | null;
  providerId: string;
  schemaVersion: number;
  config: unknown;
}>): boolean {
  const current = input.readSnapshot();
  if (!current || getActiveAccountSettingsSnapshotLifetimeToken() !== input.snapshotLifetimeToken) {
    return false;
  }
  if (input.snapshot.scopeKey === undefined || current.scopeKey === undefined) {
    return current === input.snapshot;
  }
  if (current.scopeKey !== input.snapshot.scopeKey) return false;

  const root = current.settings.voiceSettingsV1;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const providers = (root as Readonly<Record<string, unknown>>).providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false;
  const envelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(
    (providers as Readonly<Record<string, unknown>>)[input.providerId],
  );
  return envelope.success
    && envelope.data.schemaVersion === input.schemaVersion
    && isDeepStrictEqual(envelope.data.config, input.config);
}

type SpeechCredentialAuthority = ReturnType<typeof resolveAccountSettingsVoiceCredentialSource>;
type SpeechCredentialAdmission = Readonly<{
  hasSelectedSource: boolean;
  isAuthorityCurrent(): boolean;
}>;

function resolveSpeechCredentialAuthority(input: Readonly<{
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  target: VoiceSpeechTargetRef;
  accountSettings: Readonly<Record<string, unknown>>;
  machineId: string | null;
}>): SpeechCredentialAuthority {
  const declaration = input.contribution.credentials;
  if (!declaration) throw credentialUnavailable();
  try {
    return resolveAccountSettingsVoiceCredentialSource(input.accountSettings, {
      contribution: input.target,
      credentialSlotId: declaration.slot.id,
      purpose: { consumer: input.target, purpose: declaration.slot.purpose },
      machineId: input.machineId,
    });
  } catch {
    throw credentialUnavailable();
  }
}

function isSpeechCredentialAuthorityCurrent(input: Readonly<{
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  target: VoiceSpeechTargetRef;
  readAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  authority: SpeechCredentialAuthority;
}>): boolean {
  const current = input.readAccountSettingsSnapshot();
  if (!current) return false;
  try {
    return isDeepStrictEqual(
      resolveSpeechCredentialAuthority({
        contribution: input.contribution,
        target: input.target,
        accountSettings: current.settings as unknown as Readonly<Record<string, unknown>>,
        machineId: input.machineId,
      }),
      input.authority,
    );
  } catch {
    return false;
  }
}

function resolveSpeechCredentialAdmission(input: Readonly<{
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  target: VoiceSpeechTargetRef;
  providerSettings: Readonly<Record<string, unknown>>;
  accountSettings: Readonly<Record<string, unknown>>;
  readAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
}>): SpeechCredentialAdmission {
  const declaration = input.contribution.credentials;
  if (!declaration) {
    return Object.freeze({
      hasSelectedSource: false,
      isAuthorityCurrent: () => true,
    });
  }
  const requirementActive = declaration.requirement.kind === 'always'
    || (declaration.requirement.kind === 'when_setting_equals'
      && input.providerSettings[declaration.requirement.settingId] === declaration.requirement.value);
  // Account Settings owns this exact non-secret projection: selected source,
  // effective binding, SavedSecret reference, and recipient approval.
  const authority = resolveSpeechCredentialAuthority(input);
  if (authority.selection.kind === 'none') {
    if (requirementActive) throw credentialUnavailable();
    return Object.freeze({
      hasSelectedSource: false,
      isAuthorityCurrent: () => isSpeechCredentialAuthorityCurrent({
        contribution: input.contribution,
        target: input.target,
        readAccountSettingsSnapshot: input.readAccountSettingsSnapshot,
        machineId: input.machineId,
        authority,
      }),
    });
  }
  return Object.freeze({
    hasSelectedSource: true,
    isAuthorityCurrent: () => isSpeechCredentialAuthorityCurrent({
      contribution: input.contribution,
      target: input.target,
      readAccountSettingsSnapshot: input.readAccountSettingsSnapshot,
      machineId: input.machineId,
      authority,
    }),
  });
}

function resolveSpeechCredentialAccess(input: Readonly<{
  phase: VoiceSpeechCredentialPhase;
  admission: SpeechCredentialAdmission;
  mediated: VoiceSpeechCredentialAccess['mediated'];
  raw: VoiceSpeechCredentialAccess['raw'];
}>): VoiceSpeechCredentialAccess {
  if (!input.admission.hasSelectedSource) return unavailableSpeechCredentials(input.phase);
  // Mediated and raw access are independent declarations. A contribution that
  // declares only host-mediated operations is fully usable without a raw
  // grant, and one that declares only a raw grant is unaffected by mediation.
  if (!input.raw && !input.mediated) throw credentialUnavailable();
  return Object.freeze({ phase: input.phase, mediated: input.mediated, raw: input.raw });
}

export function registerMachineVoiceSpeechRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  machineId?: string | null;
  resolveSpeechRuntime?(target: VoiceSpeechTargetRef): Promise<VoiceSpeechRuntimeLease>;
  resolveRawCredentialDependencies?(): Promise<RawCredentialDependencies | null>;
}>): MachineVoiceSpeechRpcRegistration {
  const ttlMs = Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs || 60_000));
  const chunkSizeBytes = Math.min(
    VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES,
    Math.max(1, Math.trunc(configuration.filesTransferChunkBytes)),
  );
  const uploadStore = new TransferSessionStore({ ttlMs });
  const downloadStore = new TransferSessionStore({ ttlMs });
  const uploads = createTransferSessionLifecycle({ store: uploadStore, chunkSizeBytes });
  const downloads = createTransferSessionLifecycle({ store: downloadStore, chunkSizeBytes });
  const uploadMetadata = new Map<string, UploadMetadata>();
  const finalizedUploads = new Map<string, FinalizedUpload>();
  const finalizedUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const downloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const downloadFiles = new Map<string, string>();
  const outputFiles = new Set<string>();
  let outputRootPromise: Promise<string> | null = null;
  let disposed = false;
  const resolveRawCredentialDependencies: () => Promise<RawCredentialDependencies | null> =
    params.resolveRawCredentialDependencies ?? (async () => {
      const storedCredentials = await readStoredCredentials();
      if (!storedCredentials) return null;
      return Object.freeze({ credentials: storedCredentials });
    });

  const resolveSpeechRuntime = params.resolveSpeechRuntime ?? (async (target: VoiceSpeechTargetRef): Promise<VoiceSpeechRuntimeLease> => {
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      await lease.registry.activateContributionsOnDemand([{
        pluginId: target.pluginId,
        family: 'voiceProviders',
        localId: target.localId,
      }]);
      const speech = lease.registry.voiceSpeechProviders?.read(target) ?? null;
      const lifecycle = lease.registry.resolveVoiceProviderRuntimeLifecycle?.(target) ?? null;
      if (!speech?.isCurrent()) {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }
      const rawCredentialMaterializers = new Map<
        VoiceSpeechCredentialPhase,
        PluginRawCredentialMaterializer
      >();
      let readAccountSettingsSnapshot = getActiveAccountSettingsSnapshot;
      const manifest = lease.registry.contributes.activationTargets.find((candidate) => (
        candidate.pluginId === target.pluginId
        && candidate.manifest.contributes.voiceProviders?.some((contribution) => (
          contribution.id === target.localId
          && contribution.kind === 'speech'
        )) === true
      ))?.manifest ?? null;
      const hasDeclaredRawSpeechAccess = (phase: VoiceSpeechCredentialPhase) => (
        speech.contribution.credentials?.sources.some((source) => (
          source.rawGrants?.some((grant) => (
            grant.realm === 'daemon' && grant.phase === phase
          )) === true
        )) === true
      );
      // Mediated access is declared exactly as the client realm declares it.
      // The Account-operation owner decides which phases a contribution kind
      // may reach, so this seam asks it rather than re-encoding the phase.
      const hasDeclaredMediatedSpeechAccess = (phase: VoiceSpeechCredentialPhase) => (
        declaresAdmittedMediatedOperations(speech.contribution, phase)
      );
      let createMediatedOperationAccess:
        | ((
            phase: VoiceSpeechCredentialPhase,
            signal: AbortSignal,
            isCurrent: () => boolean,
          ) => VoiceSpeechCredentialAccess['mediated'])
        | null = null;
      if (
        manifest
        && VOICE_SPEECH_CREDENTIAL_PHASES.some((phase) => (
          hasDeclaredRawSpeechAccess(phase) || hasDeclaredMediatedSpeechAccess(phase)
        ))
        && (lease.registry.generation === undefined
          || speech.generation === String(lease.registry.generation))
      ) {
        const dependencies = await resolveRawCredentialDependencies();
        if (dependencies?.getAccountSettingsSnapshot) {
          readAccountSettingsSnapshot = dependencies.getAccountSettingsSnapshot;
        }
        if (!readAccountSettingsSnapshot() && dependencies?.ensureAccountSettingsSnapshot) {
          await dependencies.ensureAccountSettingsSnapshot();
        } else if (!readAccountSettingsSnapshot() && dependencies?.credentials) {
          await warmActiveAccountSettingsSnapshotBestEffort({ credentials: dependencies.credentials });
        }
        if (!speech.isCurrent()) {
          throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
        }
        const connectedAccounts = lease.registry.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
        if (lifecycle) {
          const voiceProviders = lease.registry.contributes.voiceProviders ?? [];
          const transport = createGlobalFetchRuntime();
          createMediatedOperationAccess = (phase, signal, isCurrent) => {
            if (!hasDeclaredMediatedSpeechAccess(phase)) return null;
            return createVoiceAccountOperationService({
              voiceProviders,
              provider: target,
              kind: 'speech',
              phase,
              credentialResolver: createVoiceCredentialResolver({
                machineId: params.machineId ?? null,
                getSnapshot: readAccountSettingsSnapshot,
              }),
              isCurrent: () => speech.isCurrent() && lifecycle.isCurrent() && isCurrent(),
              signal,
              transport,
            });
          };
          if (dependencies) {
            for (const phase of VOICE_SPEECH_CREDENTIAL_PHASES) {
              if (!hasDeclaredRawSpeechAccess(phase)) continue;
              rawCredentialMaterializers.set(phase, createDaemonPluginRawCredentialMaterializer({
                binding: {
                  manifest,
                  contribution: target,
                  realm: 'daemon',
                  phase,
                  machineId: params.machineId ?? null,
                  immutableGenerationId: lifecycle.generation,
                  isRuntimeAuthorityCurrent: () => speech.isCurrent() && lifecycle.isCurrent(),
                },
                ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
                ...(dependencies.currentInstallReviewPrincipal
                  ? { currentInstallReviewPrincipal: dependencies.currentInstallReviewPrincipal }
                  : {}),
                ...(dependencies.readCurrentGrantAuthoritySource
                  ? { readCurrentGrantAuthoritySource: dependencies.readCurrentGrantAuthoritySource }
                  : {}),
                ...(dependencies.grants ? { grants: dependencies.grants } : {}),
                ...(connectedAccounts ? { connectedAccounts } : {}),
                ...(dependencies.getAccountSettingsSnapshot
                  ? { getAccountSettingsSnapshot: dependencies.getAccountSettingsSnapshot }
                  : {}),
                ...(dependencies.ensureAccountSettingsSnapshot
                  ? { ensureAccountSettingsSnapshot: dependencies.ensureAccountSettingsSnapshot }
                  : {}),
              }));
            }
          }
        }
      }
      return Object.freeze({
        runtime: speech.runtime,
        contribution: speech.contribution,
        readSettings() {
          const snapshot = readAccountSettingsSnapshot();
          const root = snapshot?.settings.voiceSettingsV1;
          if (!root || typeof root !== 'object' || Array.isArray(root)) {
            throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
          }
          const providers = (root as Readonly<Record<string, unknown>>).providers;
          if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
            throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
          }
          const providerId = buildQualifiedPluginContributionKey(target);
          const envelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(
            (providers as Readonly<Record<string, unknown>>)[providerId],
          );
          if (!envelope.success || envelope.data.schemaVersion !== speech.contribution.settings.schemaVersion) {
            throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
          }
          const snapshotLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
          const isCurrent = () => (
            speech.isCurrent()
            && isSpeechSettingsSnapshotCurrent({
              snapshot,
              snapshotLifetimeToken,
              readSnapshot: readAccountSettingsSnapshot,
              providerId,
              schemaVersion: speech.contribution.settings.schemaVersion,
              config: envelope.data.config,
            })
          );
          return Object.freeze({
            settings: envelope.data.config,
            resolveCredentials(
              providerSettings: Readonly<Record<string, unknown>>,
              signal: AbortSignal,
              phase: VoiceSpeechCredentialPhase = 'speech',
              bindCredentialAuthorityCurrent?: (isCurrent: () => boolean) => void,
            ) {
              const admission = resolveSpeechCredentialAdmission({
                contribution: speech.contribution,
                target,
                providerSettings,
                accountSettings: snapshot.settings as unknown as Readonly<Record<string, unknown>>,
                readAccountSettingsSnapshot,
                machineId: params.machineId ?? null,
              });
              const isOperationCurrent = () => isCurrent() && admission.isAuthorityCurrent();
              const credentials = resolveSpeechCredentialAccess({
                phase,
                admission,
                mediated: createMediatedOperationAccess?.(phase, signal, isOperationCurrent) ?? null,
                raw: rawCredentialMaterializers.get(phase)
                  ? createInvocationVoiceRawCredentialAccess({
                      materializer: rawCredentialMaterializers.get(phase)!,
                      signal,
                      isCurrent: isOperationCurrent,
                    })
                  : null,
              });
              bindCredentialAuthorityCurrent?.(admission.isAuthorityCurrent);
              return credentials;
            },
            isCurrent,
          });
        },
        createHttp: speech.createHttp,
        isCurrent: speech.isCurrent,
        retirementSignal: speech.retirementSignal,
        release: lease.release,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
  });

  const outputRoot = async () => outputRootPromise ??= mkdtemp(join(tmpdir(), 'happier-voice-speech-'));
  const clearUpload = async (uploadId: string) => {
    const timer = finalizedUploadTimers.get(uploadId);
    if (timer) clearTimeout(timer);
    finalizedUploadTimers.delete(uploadId);
    const finalized = finalizedUploads.get(uploadId);
    finalizedUploads.delete(uploadId);
    uploadMetadata.delete(uploadId);
    await uploads.abortUploadTransferSession({ uploadId }).catch(() => undefined);
    if (finalized) await rm(finalized.path, { force: true }).catch(() => undefined);
  };
  const scheduleUploadExpiry = (uploadId: string) => {
    const existing = finalizedUploadTimers.get(uploadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void clearUpload(uploadId); }, ttlMs);
    timer.unref?.();
    finalizedUploadTimers.set(uploadId, timer);
  };
  const clearDownload = async (downloadId: string) => {
    const timer = downloadTimers.get(downloadId);
    if (timer) clearTimeout(timer);
    downloadTimers.delete(downloadId);
    await downloads.abortDownloadTransferSession({ downloadId }).catch(() => undefined);
    const filePath = downloadFiles.get(downloadId);
    downloadFiles.delete(downloadId);
    if (filePath) outputFiles.delete(filePath);
  };
  const scheduleDownloadExpiry = (downloadId: string) => {
    const existing = downloadTimers.get(downloadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void clearDownload(downloadId); }, ttlMs);
    timer.unref?.();
    downloadTimers.set(downloadId, timer);
  };
  const runBounded = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    lease: VoiceSpeechRuntimeLease,
    transportSignal?: AbortSignal,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    const signal = AbortSignal.any([
      controller.signal,
      lease.retirementSignal,
      ...(transportSignal ? [transportSignal] : []),
    ]);
    try {
      return await operation(signal);
    } catch (error) {
      if (lease.retirementSignal.aborted || !lease.isCurrent()) {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }
      if (transportSignal?.aborted) {
        throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      }
      if (controller.signal.aborted) {
        throw Object.assign(new Error('request_timeout'), { code: 'request_timeout' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  };
  const throwIfTransportCancelled = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('RPC request cancelled'), { name: 'AbortError' });
  };
  const assertOperationMayPublish = (
    lease: VoiceSpeechRuntimeLease,
    signal: AbortSignal,
    isOperationCurrent: (() => boolean) | undefined = undefined,
  ) => {
    throwIfTransportCancelled(signal);
    if (!lease.isCurrent() || isOperationCurrent?.() === false) {
      throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
    }
  };
  const validateTranscriptionResult = (value: unknown, requestId: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
    }
    const result = value as Record<string, unknown>;
    if (result.requestId !== requestId || typeof result.text !== 'string' || result.text.length > 1_000_000) {
      throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
    }
    return Object.freeze({ requestId, text: result.text });
  };
  const createSpeechOperationContext = (lease: VoiceSpeechRuntimeLease, signal: AbortSignal) => {
    try {
      const settingsLease = lease.readSettings();
      if (!settingsLease.isCurrent()) {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }
      const correspondence = resolveVoiceSpeechSettingsCorrespondence({
        contribution: lease.contribution,
        settings: settingsLease.settings,
      });
      const endpointPolicy = resolveVoiceSpeechEndpointPolicy({
        settings: correspondence.settings,
        machineId: params.machineId ?? null,
      });
      let isCredentialAuthorityCurrent = () => true;
      const credentials = settingsLease.resolveCredentials(
        correspondence.settings,
        signal,
        'speech',
        (isCurrent) => { isCredentialAuthorityCurrent = isCurrent; },
      );
      if (credentials.phase !== 'speech') throw credentialUnavailable();
      const isCurrent = () => settingsLease.isCurrent() && isCredentialAuthorityCurrent();
      if (!isCurrent()) {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }
      return Object.freeze({
        correspondence,
        isCurrent,
        context: Object.freeze({
          credentials,
          settings: correspondence.settings,
          http: lease.createHttp(signal, isCurrent, endpointPolicy),
          signal,
        }),
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (
        code === 'provider_unavailable'
        || code === 'credential_unavailable'
        || code === 'plugin_voice_credential_access_unavailable'
      ) throw error;
      throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
    }
  };
  const validateAndCopySynthesisResult = (value: unknown, requestId: string, maxOutputBytes: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
    }
    const result = value as Record<string, unknown>;
    if (
      result.requestId !== requestId
      || !(result.bytes instanceof Uint8Array)
      || result.bytes.byteLength < 1
      || result.bytes.byteLength > maxOutputBytes
      || (result.mimeType !== 'audio/mpeg' && result.mimeType !== 'audio/wav')
    ) {
      throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
    }
    return Object.freeze({
      requestId,
      bytes: new Uint8Array(result.bytes),
      mimeType: result.mimeType,
    });
  };
  const classify = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'credential_unavailable' || code === 'plugin_voice_credential_access_unavailable') {
      return { ok: false as const, errorCode: 'credential_unavailable' as const };
    }
    if (code === 'provider_unavailable') return { ok: false as const, errorCode: 'provider_unavailable' as const };
    if (code === 'provider_settings_invalid') return { ok: false as const, errorCode: 'invalid_parameters' as const };
    if (code === 'cancelled') return { ok: false as const, errorCode: 'cancelled' as const };
    if (code === 'request_timeout') return { ok: false as const, errorCode: 'request_timeout' as const };
    if ((error as { name?: unknown } | null)?.name === 'AbortError') return { ok: false as const, errorCode: 'request_timeout' as const };
    if (code === 'provider_response_invalid' || code === 'plugin_voice_provider_result_invalid') {
      return { ok: false as const, errorCode: 'provider_response_invalid' as const };
    }
    return { ok: false as const, errorCode: 'internal_error' as const };
  };
  const sameTarget = (left: VoiceSpeechTargetRef, right: VoiceSpeechTargetRef) => (
    left.pluginId === right.pluginId && left.localId === right.localId
  );

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    const parsed = DaemonVoiceSpeechCatalogRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', retryable: false };
    }
    const { target, catalog } = parsed.data;
    let lease: VoiceSpeechRuntimeLease | null = null;
    try {
      lease = await resolveSpeechRuntime(target);
      if (
        !lease.runtime.catalog
        || !lease.contribution.catalogs?.some((declaration) => declaration.kind === catalog)
      ) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', retryable: false };
      const response = await runBounded(async (signal) => {
        assertOperationMayPublish(lease!, signal);
        const operation = createSpeechOperationContext(lease!, signal);
        const result = await lease!.runtime.catalog!.list(
          { catalog },
          operation.context,
        );
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        const validated = VoiceProviderCatalogResponseSchema.safeParse({ ok: true, items: result });
        if (!validated.success) {
          throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
        }
        return validated.data;
      }, lease, context?.signal);
      return response;
    } catch (error) {
      const failure = classify(error);
      return VoiceProviderCatalogResponseSchema.parse({ ok: false, errorCode: failure.errorCode, error: failure.errorCode, retryable: failure.errorCode === 'request_timeout' });
    } finally { await lease?.release(); }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_SETTINGS_ACTION_EXECUTE, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    const parsed = DaemonVoiceSpeechSettingsActionRequestSchema.safeParse(raw);
    if (!parsed.success) return DaemonVoiceSpeechSettingsActionResponseSchema.parse(invalid);
    let lease: VoiceSpeechRuntimeLease | null = null;
    try {
      lease = await resolveSpeechRuntime(parsed.data.target);
      const declared = lease.contribution.settings.actions?.some(
        (action) => action.id === parsed.data.actionId,
      ) === true;
      if (!declared || !lease.runtime.settingsActions) {
        return DaemonVoiceSpeechSettingsActionResponseSchema.parse(invalid);
      }
      const response = await runBounded(async (signal) => {
        assertOperationMayPublish(lease!, signal);
        const settingsLease = lease!.readSettings();
        if (!settingsLease.isCurrent()) {
          throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
        }
        const correspondence = resolveVoiceSpeechSettingsCorrespondence({
          contribution: lease!.contribution,
          settings: settingsLease.settings,
        });
        let isCredentialAuthorityCurrent = () => true;
        const credentials = settingsLease.resolveCredentials(
          correspondence.settings,
          signal,
          'settings',
          (isCurrent) => { isCredentialAuthorityCurrent = isCurrent; },
        );
        if (credentials.phase !== 'settings') throw credentialUnavailable();
        const isCurrent = () => settingsLease.isCurrent() && isCredentialAuthorityCurrent();
        if (!isCurrent()) {
          throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
        }
        const result = await lease!.runtime.settingsActions!.execute(
          { actionId: parsed.data.actionId, settings: correspondence.settings },
          {
            credentials,
            interactions: createPluginInteractionsService({
              currentSession: null,
              signal,
              isGenerationCurrent: isCurrent,
            }),
            signal,
            tools: Object.freeze([]),
          },
        );
        assertOperationMayPublish(lease!, signal, isCurrent);
        const validated = DaemonVoiceSpeechSettingsActionResponseSchema.safeParse({
          ok: true,
          patch: result.patch,
        });
        if (!validated.success) {
          throw Object.assign(new Error('provider_response_invalid'), { code: 'provider_response_invalid' });
        }
        return validated.data;
      }, lease, context?.signal);
      return response;
    } catch (error) {
      return DaemonVoiceSpeechSettingsActionResponseSchema.parse(classify(error));
    } finally { await lease?.release(); }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechTranscribeUploadInitRequestSchema.safeParse(raw);
    if (!parsed.success || disposed) return transferInvalid;
    const { target, ...upload } = parsed.data;
    try {
      const recipient = createTransferRecipientKeyPair();
      const session = await uploads.openUploadTransferSession({
        target: {
          destPath: 'voice-speech-transcribe', destDisplayPath: 'voice-speech-transcribe',
          expectedSizeBytes: upload.sizeBytes, overwrite: true,
          finalizeUpload: async ({ tempPath, sizeBytes }) => ({ success: true, path: tempPath, sizeBytes }),
        },
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      uploadMetadata.set(session.uploadId, { target, ...upload });
      scheduleUploadExpiry(session.uploadId);
      return DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse({
        success: true,
        uploadId: session.uploadId,
        chunkSizeBytes: session.chunkSizeBytes,
        recipientPublicKeyBase64: session.recipientPublicKeyBase64,
      });
    } catch {
      return transferFailure('transfer_failed');
    }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechTranscribeUploadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const response = await uploads.writeUploadTransferChunk(parsed.data);
    if (!response.success) return uploadMetadata.has(parsed.data.uploadId) ? transferFailure('transfer_failed') : transferFailure('transfer_not_found');
    scheduleUploadExpiry(parsed.data.uploadId);
    return DaemonVoiceSpeechTranscribeUploadChunkResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const metadata = uploadMetadata.get(parsed.data.uploadId);
    if (!metadata) return transferFailure('transfer_not_found');
    const result = await uploads.finalizeUploadTransferSession(parsed.data);
    if (!result.success) return transferFailure('transfer_failed');
    uploadMetadata.delete(parsed.data.uploadId);
    finalizedUploads.set(parsed.data.uploadId, { ...metadata, path: result.finalized.path, sizeBytes: result.finalized.sizeBytes });
    scheduleUploadExpiry(parsed.data.uploadId);
    return DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse({ success: true, uploadId: parsed.data.uploadId, sizeBytes: result.finalized.sizeBytes, sha256: result.sha256 });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechTranscribeUploadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    await clearUpload(parsed.data.uploadId);
    return DaemonVoiceSpeechTranscribeUploadAbortResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    let lease: VoiceSpeechRuntimeLease | null = null;
    let uploaded: FinalizedUpload | undefined;
    const parsed = DaemonVoiceSpeechTranscribeRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid;
    const { target, requestId, model, language, mimeType, uploadId } = parsed.data;
    try {
      lease = await resolveSpeechRuntime(target);
    } catch (error) {
      return classify(error);
    }
    if (!lease.runtime.transcribe) {
      await lease.release();
      return invalid;
    }
    uploaded = finalizedUploads.get(uploadId);
    const maxInputBytes = Math.min(
      VOICE_SPEECH_INPUT_MAX_BYTES,
      lease.contribution.limits?.transcribe?.maxInputBytes ?? VOICE_SPEECH_INPUT_MAX_BYTES,
    );
    if (
      !uploaded
      || uploaded.mimeType !== mimeType
      || uploaded.sizeBytes > maxInputBytes
      || !sameTarget(uploaded.target, target)
    ) {
      await lease.release();
      return invalid;
    }
    finalizedUploads.delete(uploadId);
    const uploadTimer = finalizedUploadTimers.get(uploadId);
    if (uploadTimer) clearTimeout(uploadTimer);
    finalizedUploadTimers.delete(uploadId);
    try {
      const result = await runBounded(async (signal) => {
        const bytes = new Uint8Array(await readFile(uploaded!.path));
        assertOperationMayPublish(lease!, signal);
        const operation = createSpeechOperationContext(lease!, signal);
        if (!operation.correspondence.transcribe
          || operation.correspondence.transcribe.model !== model) {
          throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
        }
        const providerResult = await lease!.runtime.transcribe!(
          { requestId, model, language, mimeType, bytes },
          operation.context,
        );
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        return Object.freeze({ ok: true as const, ...validateTranscriptionResult(providerResult, requestId) });
      }, lease, context?.signal);
      return DaemonVoiceSpeechTranscribeResponseSchema.parse(result);
    } catch (error) { return classify(error); }
    finally {
      await lease.release();
      await rm(uploaded.path, { force: true }).catch(() => undefined);
    }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    let lease: VoiceSpeechRuntimeLease | null = null;
    let filePath: string | null = null;
    let downloadId: string | null = null;
    const parsed = DaemonVoiceSpeechSynthesizeRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid;
    const {
      target,
      requestId,
      model,
      input,
      voiceName,
      languageCode,
      format,
      speakingRate,
      pitch,
      recipientPublicKeyBase64,
    } = parsed.data;
    try {
      parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
    } catch {
      return invalid;
    }
    try {
      lease = await resolveSpeechRuntime(target);
      if (
        input.length > (lease.contribution.limits?.synthesize?.maxInputCharacters ?? 200_000)
        || !lease.runtime.synthesize
      ) return invalid;
      return await runBounded(async (signal) => {
        assertOperationMayPublish(lease!, signal);
        const operation = createSpeechOperationContext(lease!, signal);
        if (!operation.correspondence.synthesize
          || operation.correspondence.synthesize.model !== model
          || operation.correspondence.synthesize.voiceName !== voiceName) {
          throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
        }
        const providerResult = await lease!.runtime.synthesize!(
          { requestId, input, model, voiceName, languageCode, format, speakingRate, pitch },
          operation.context,
        );
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        const synthesized = validateAndCopySynthesisResult(
          providerResult,
          requestId,
          Math.min(
            VOICE_SPEECH_OUTPUT_MAX_BYTES,
            lease!.contribution.limits?.synthesize?.maxOutputBytes ?? VOICE_SPEECH_OUTPUT_MAX_BYTES,
          ),
        );
        const root = await outputRoot();
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        filePath = join(root, `${randomUUID()}.audio`);
        await writeFile(filePath, synthesized.bytes, { mode: 0o600, signal });
        outputFiles.add(filePath);
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        const session = await downloads.openDownloadTransferSession({
          source: { filePath, deleteFileOnClose: true, sizeBytes: synthesized.bytes.byteLength, name: 'voice-speech-audio' },
          recipientPublicKeyBase64,
        });
        downloadId = session.downloadId;
        downloadFiles.set(session.downloadId, filePath);
        scheduleDownloadExpiry(session.downloadId);
        assertOperationMayPublish(lease!, signal, operation.isCurrent);
        return DaemonVoiceSpeechSynthesizeResponseSchema.parse(Object.freeze({
          ok: true as const, requestId, downloadId: session.downloadId,
          chunkSizeBytes: session.chunkSizeBytes, sizeBytes: synthesized.bytes.byteLength, mimeType: synthesized.mimeType,
        }));
      }, lease, context?.signal);
    } catch (error) {
      if (downloadId) await clearDownload(downloadId);
      else if (filePath) {
        outputFiles.delete(filePath);
        await rm(filePath, { force: true }).catch(() => undefined);
      }
      return classify(error);
    } finally { await lease?.release(); }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechDownloadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const response = await downloads.readDownloadTransferChunk(parsed.data);
    if (!response.success) return transferFailure('transfer_not_found');
    if (!('payloadBase64' in response)) return transferFailure('transfer_failed');
    scheduleDownloadExpiry(parsed.data.downloadId);
    return DaemonVoiceSpeechDownloadChunkResponseSchema.parse(response);
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechDownloadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    if (!downloadStore.getDownloadSession(parsed.data.downloadId)) return transferFailure('transfer_not_found');
    await clearDownload(parsed.data.downloadId);
    return DaemonVoiceSpeechDownloadFinalizeResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceSpeechDownloadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    await clearDownload(parsed.data.downloadId);
    return DaemonVoiceSpeechDownloadAbortResponseSchema.parse({ success: true });
  });

  return Object.freeze({
    async dispose() {
      disposed = true;
      for (const timer of finalizedUploadTimers.values()) clearTimeout(timer);
      finalizedUploadTimers.clear();
      for (const timer of downloadTimers.values()) clearTimeout(timer);
      downloadTimers.clear();
      for (const uploadId of [...finalizedUploads.keys()]) await clearUpload(uploadId);
      await uploadStore.dispose();
      await downloadStore.dispose();
      for (const path of outputFiles) await rm(path, { force: true }).catch(() => undefined);
      outputFiles.clear();
      if (outputRootPromise) await rm(await outputRootPromise, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}
