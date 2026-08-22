import { expect, type Page } from '@playwright/test';
import {
  DaemonVoiceInferenceModelsInstallResponseSchema,
  DaemonVoiceInferenceModelsWarmResponseSchema,
  DaemonVoiceInferenceStatusResponseSchema,
  readServerEnabledBit,
  type AccountScopedCryptoMaterial,
  type DaemonVoiceInferenceModelStatus,
  type DaemonVoiceInferenceServiceState,
  type FeaturesResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import tweetnacl from 'tweetnacl';

import { createTestAuth } from '../auth';
import { upsertEncryptedAccountSettingsV2 } from '../accountSettings';
import { seedCliAuthForTestAccount } from '../cliAuth';
import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { repoRootDir } from '../paths';
import { ensureCliSharedDepsBuilt } from '../process/cliDist';
import { startServerLight, type StartedServer } from '../process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../process/uiWeb';
import { createSession } from '../sessions';
import { createUserScopedSocketCollector } from '../socketClient';
import { SyntheticAgent } from '../syntheticAgent/syntheticAgent';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../syntheticAgent/rpcClient';
import { waitFor } from '../timing';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { buildAuthBootstrapStorageSnapshot } from './buildAuthBootstrapStorageSnapshot';
import {
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedRouteUi,
} from './pageNavigation';
import { installAuthBootstrapStorageSnapshot } from './readLegacyAuthSecretFromLocalStorage';
import {
  buildVoiceBrowserQaRouteFeatureEnv,
  resolveVoiceBrowserQaUiWebMode,
  type VoiceBrowserQaRouteProfile,
} from './voiceBrowserQaRouteProfile';

const OPENAI_COMPAT_STT_PROVIDER_ID = 'happier.voice.openai-compat/stt';
export {
  observeVoiceRelaySocketTraffic,
  type VoiceRelaySocketTrafficObservation,
} from './voiceRelaySocketTrafficObservation';

export type VoiceBrowserQaStack = Readonly<{
  server: StartedServer;
  ui: StartedUiWeb;
  daemon: StartedDaemon;
  uiBaseUrl: string;
  storageScope: string;
  authToken: string;
  authBootstrapSnapshot: ReturnType<typeof buildAuthBootstrapStorageSnapshot>;
  machineId: string;
  accountSigningSeed: Uint8Array;
  accountSettingsMaterial: AccountScopedCryptoMaterial;
  routeProfile: VoiceBrowserQaRouteProfile;
  daemonControlPort: number;
  daemonSttModelPackId: string | null;
  daemonSttReadiness: VoiceBrowserQaDaemonSttReadiness | null;
  restartDaemon: () => Promise<StartedDaemon>;
  createRunnableSession: () => Promise<string>;
  stopRunnableSessions: () => Promise<void>;
}>;

export type VoiceBrowserQaDaemonSttManifestEvidence = Readonly<{
  path: string;
  present: true;
  packId: string;
  version: string | null;
}>;

export type VoiceBrowserQaDaemonSttReadiness = Readonly<{
  machineId: string;
  packId: string;
  serviceState: DaemonVoiceInferenceServiceState;
  installedModel: DaemonVoiceInferenceModelStatus;
  warmedModel: DaemonVoiceInferenceModelStatus;
  finalStatusModel: DaemonVoiceInferenceModelStatus;
  manifest: VoiceBrowserQaDaemonSttManifestEvidence;
}>;

export async function readVoiceBrowserQaDaemonSttManifestEvidence(params: Readonly<{
  daemonHomeDir: string;
  serverId: string;
  packId: string;
}>): Promise<VoiceBrowserQaDaemonSttManifestEvidence> {
  const path = resolve(
    params.daemonHomeDir,
    'servers',
    params.serverId,
    'voiceInference',
    'packs',
    params.packId,
    'pack.json',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`voice_browser_qa_daemon_stt_manifest_unreadable:${path}`, { cause });
  }
  const manifest = parsed && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : null;
  if (manifest?.packId !== params.packId) {
    throw new Error(
      `voice_browser_qa_daemon_stt_manifest_identity_mismatch:${params.packId}:${String(manifest?.packId ?? '')}`,
    );
  }
  return {
    path,
    present: true,
    packId: params.packId,
    version: typeof manifest.version === 'string' ? manifest.version : null,
  };
}

async function readVoiceQaServerFeatures(baseUrl: string): Promise<FeaturesResponse> {
  const response = await fetch(new URL('/v1/features', `${baseUrl}/`));
  if (!response.ok) {
    throw new Error(`voice QA feature preflight failed: HTTP ${response.status}`);
  }
  return await response.json() as FeaturesResponse;
}

function assertVoiceQaRouteProfile(
  features: FeaturesResponse,
  source: string,
  profile: VoiceBrowserQaRouteProfile,
  daemonControlPort: number,
): void {
  const expected = profile === 'direct'
    ? {
        'machines.rpc.directPeer': true,
        'machines.tunnel.directPeer': true,
        'machines.liveStream.directPeer': true,
        'machines.tunnel.serverRouted': false,
        'machines.liveStream.serverRouted': false,
      }
    : {
        'machines.rpc.directPeer': false,
        'machines.tunnel.directPeer': false,
        'machines.liveStream.directPeer': false,
        'machines.tunnel.serverRouted': true,
        'machines.liveStream.serverRouted': true,
      };
  for (const [featureId, enabled] of Object.entries(expected)) {
    if (readServerEnabledBit(features, featureId as Parameters<typeof readServerEnabledBit>[1]) !== enabled) {
      throw new Error(`voice QA ${source} feature preflight: ${featureId} did not match ${profile} profile`);
    }
  }
  if (!features.capabilities.machines.tunnel.directPeer.allowedPorts.includes(daemonControlPort)) {
    throw new Error(`voice QA ${source} feature preflight: daemon control port is not authorized`);
  }
}

async function installVoiceBrowserQaDaemonSttModel(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  rpcKey: Uint8Array;
  machineId: string;
  packId: string;
  daemonHomeDir: string;
  serverId: string;
}>): Promise<VoiceBrowserQaDaemonSttReadiness> {
  const socket = createUserScopedSocketCollector(params.serverBaseUrl, params.authToken, {
    captureEvents: false,
  });
  socket.connect();
  const machineRpc = createDataKeyRpcClient(socket, params.rpcKey);
  try {
    await waitFor(() => socket.isConnected(), {
      timeoutMs: 30_000,
      context: 'Voice browser QA model-install socket',
    });
    await waitFor(async () => {
      const raw = await machineRpc.call(
        `${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`,
        {},
        30_000,
      );
      return DaemonVoiceInferenceStatusResponseSchema.parse(
        unwrapDataKeyRpcResult(raw, 'Voice browser QA daemon inference status'),
      ).ok === true;
    }, {
      timeoutMs: 60_000,
      context: 'Voice browser QA daemon inference readiness',
    });
    const installed = DaemonVoiceInferenceModelsInstallResponseSchema.parse(
      unwrapDataKeyRpcResult(
        await machineRpc.call(
          `${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL}`,
          { packId: params.packId },
          180_000,
        ),
        'Voice browser QA daemon STT model install',
      ),
    );
    if (!installed.ok || installed.model.installState !== 'installed') {
      throw new Error(`voice_browser_qa_daemon_stt_model_install_failed:${params.packId}`);
    }
    const warmed = DaemonVoiceInferenceModelsWarmResponseSchema.parse(
      unwrapDataKeyRpcResult(
        await machineRpc.call(
          `${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM}`,
          { packIds: [params.packId] },
          180_000,
        ),
        'Voice browser QA daemon STT model warm',
      ),
    );
    if (!warmed.ok) {
      throw new Error(`voice_browser_qa_daemon_stt_model_warm_failed:${warmed.errorCode}`);
    }
    const warmedModel = warmed.models.find((model) => model.packId === params.packId);
    if (!warmedModel || warmedModel.runtimeState !== 'ready') {
      throw new Error(`voice_browser_qa_daemon_stt_model_warm_not_ready:${params.packId}`);
    }
    const finalStatus = DaemonVoiceInferenceStatusResponseSchema.parse(
      unwrapDataKeyRpcResult(
        await machineRpc.call(
          `${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`,
          {},
          30_000,
        ),
        'Voice browser QA daemon inference final status',
      ),
    );
    if (!finalStatus.ok) {
      throw new Error(`voice_browser_qa_daemon_stt_final_status_failed:${finalStatus.errorCode}`);
    }
    const finalStatusModel = finalStatus.models.find((model) => model.packId === params.packId);
    if (
      !finalStatusModel
      || finalStatusModel.installState !== 'installed'
      || finalStatusModel.runtimeState !== 'ready'
    ) {
      throw new Error(`voice_browser_qa_daemon_stt_final_status_not_ready:${params.packId}`);
    }
    return {
      machineId: params.machineId,
      packId: params.packId,
      serviceState: finalStatus.serviceState,
      installedModel: installed.model,
      warmedModel,
      finalStatusModel,
      manifest: await readVoiceBrowserQaDaemonSttManifestEvidence({
        daemonHomeDir: params.daemonHomeDir,
        serverId: params.serverId,
        packId: params.packId,
      }),
    };
  } finally {
    socket.disconnect();
  }
}

export async function startVoiceBrowserQaStack(params: Readonly<{
  suiteDir: string;
  storageScope: string;
  routeProfile: VoiceBrowserQaRouteProfile;
  accountMode?: 'legacy' | 'data_key';
  daemonSttModel?: Readonly<{
    packId: string;
    manifestUrl: string;
  }>;
}>): Promise<VoiceBrowserQaStack> {
  const daemonHomeDir = resolve(params.suiteDir, 'daemon-home');
  await mkdir(daemonHomeDir, { recursive: true });
  const daemonControlPort = await reserveAvailablePort();
  const uiWebMode = resolveVoiceBrowserQaUiWebMode(process.env);
  const peerMediationSigningKeyPair = tweetnacl.sign.keyPair();
  const uiWebEnv = {
    ...process.env,
    EXPO_PUBLIC_DEBUG: '1',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: params.storageScope,
    HAPPIER_E2E_UI_WEB_MODE: uiWebMode,
  };
  const server = await startServerLight({
    testDir: params.suiteDir,
    dbProvider: 'sqlite',
    extraEnv: {
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      // This QA lane is intentionally source-current. Launch the isolated
      // server entrypoint directly instead of paying for an extra Yarn
      // workspace process (and risking stale wrapper/build state) on every
      // long media replay.
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_FEATURE_VOICE__ENABLED: '1',
      HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
      ...buildVoiceBrowserQaRouteFeatureEnv(params.routeProfile, daemonControlPort),
      // Both isolated route profiles use the production signed peer-mediation
      // authorization contract. The feature profile above decides which route
      // is eligible; this key does not override that production decision.
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'voice-q2-route-grant-key',
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(peerMediationSigningKeyPair.secretKey).toString('base64url'),
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: Buffer.from(peerMediationSigningKeyPair.publicKey).toString('base64url'),
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
    },
  });
  assertVoiceQaRouteProfile(
    await readVoiceQaServerFeatures(server.baseUrl),
    'node',
    params.routeProfile,
    daemonControlPort,
  );
  let daemon: StartedDaemon | null = null;
  const runnableSessionAgents = new Set<SyntheticAgent>();
  try {
    const auth = await createTestAuth(server.baseUrl);
    const accountMode = params.accountMode ?? 'legacy';
    const authMode = accountMode === 'data_key' ? 'dataKey' : 'legacy';
    const accountMachineKey = accountMode === 'data_key'
      ? auth.accountMachineKey
      : null;
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: authMode,
    });
    const accountSettingsMaterial: AccountScopedCryptoMaterial = accountMachineKey
      ? { type: 'dataKey', machineKey: accountMachineKey }
      : { type: 'legacy', secret: auth.accountSigningSeed };
    const authBootstrapSnapshot = buildAuthBootstrapStorageSnapshot({
      serverUrl: server.baseUrl,
      auth,
      mode: authMode,
      storageScope: params.storageScope,
    });
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      // A cold source-entrypoint snapshot after a developer restart can spend
      // well over 20 seconds loading/transpiling before it writes daemon state.
      // Keep the gate bounded without mistaking cold startup for a crash.
      HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS: '300000',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_DAEMON_CONTROL_PORT: String(daemonControlPort),
      // The source-entrypoint daemon intentionally has no packaged runtime asset tree.
      // Point its existing runtime-loader seam at the real source engine so this gate
      // exercises production inference rather than a fake runtime or an unavailable package path.
      HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE: pathToFileURL(resolve(
        repoRootDir(),
        'apps/cli/src/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.ts',
      )).href,
      ...(params.daemonSttModel
        ? {
            HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
              [params.daemonSttModel.packId]: params.daemonSttModel.manifestUrl,
            }),
          }
        : null),
    };
    await ensureCliSharedDepsBuilt(
      { testDir: params.suiteDir, env: daemonEnv },
      { skipSourceFreshnessCheck: true },
    );
    daemon = await startTestDaemon({
      testDir: params.suiteDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    if (daemon.state.httpPort !== daemonControlPort) {
      throw new Error(
        `voice QA daemon control port mismatch: expected ${daemonControlPort}, received ${daemon.state.httpPort}`,
      );
    }
    let daemonSttReadiness: VoiceBrowserQaDaemonSttReadiness | null = null;
    if (params.daemonSttModel) {
      daemonSttReadiness = await installVoiceBrowserQaDaemonSttModel({
        serverBaseUrl: server.baseUrl,
        authToken: auth.token,
        rpcKey: accountMachineKey ?? auth.accountSigningSeed,
        machineId: seeded.machineId,
        packId: params.daemonSttModel.packId,
        daemonHomeDir,
        serverId: seeded.serverId,
      });
    }
    const ui = await startUiWeb({
      testDir: params.suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });
    return {
      server,
      ui,
      get daemon() {
        if (!daemon) throw new Error('voice QA daemon missing');
        return daemon;
      },
      uiBaseUrl: normalizeLoopbackBaseUrl(ui.baseUrl),
      storageScope: params.storageScope,
      authToken: auth.token,
      authBootstrapSnapshot,
      machineId: seeded.machineId,
      accountSigningSeed: auth.accountSigningSeed,
      accountSettingsMaterial,
      routeProfile: params.routeProfile,
      daemonControlPort,
      daemonSttModelPackId: params.daemonSttModel?.packId ?? null,
      daemonSttReadiness,
      restartDaemon: async () => {
        await daemon?.stop();
        daemon = await startTestDaemon({
          testDir: params.suiteDir,
          happyHomeDir: daemonHomeDir,
          env: daemonEnv,
        });
        if (daemon.state.httpPort !== daemonControlPort) {
          const actualPort = daemon.state.httpPort;
          await daemon.stop().catch(() => {});
          throw new Error(
            `voice QA restarted daemon control port mismatch: expected ${daemonControlPort}, received ${actualPort}`,
          );
        }
        return daemon;
      },
      createRunnableSession: async () => {
        const dataKey = Uint8Array.from(randomBytes(32));
        const created = await createSession(server.baseUrl, auth.token, {
          dataEncryptionKeyBase64: Buffer.from(dataKey).toString('base64'),
        });
        const agent = new SyntheticAgent({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId: created.sessionId,
          dataKey,
        });
        await agent.start();
        runnableSessionAgents.add(agent);
        return created.sessionId;
      },
      stopRunnableSessions: async () => {
        const agents = [...runnableSessionAgents];
        runnableSessionAgents.clear();
        await Promise.all(agents.map(async (agent) => await agent.stop().catch(() => {})));
      },
    };
  } catch (error) {
    await daemon?.stop().catch(() => {});
    await server.stop().catch(() => {});
    throw error;
  }
}

export function resolveVoiceBrowserQaBeforeAllTimeoutMs(): number {
  const uiWebMode = resolveVoiceBrowserQaUiWebMode(process.env);
  return resolveUiWebBeforeAllTimeoutMs({
    ...process.env,
    EXPO_PUBLIC_DEBUG: '1',
    HAPPIER_E2E_UI_WEB_MODE: uiWebMode,
  });
}

export function matchesVoiceMediaCaptureIdentity(params: Readonly<{
  callsBeforeCapture: number;
  capturedAdmissionAtMs: number;
  currentCalls: number;
  observedAdmissionAtMs: number | null;
}>): boolean {
  return params.currentCalls === params.callsBeforeCapture + 1
    && params.observedAdmissionAtMs === params.capturedAdmissionAtMs;
}

export function installVoiceMediaInstrumentation(page: Page): Promise<void> {
  return page.addInitScript(() => {
    type QaState = {
      calls: number;
      stoppedTracks: number;
      maxInputLevel: number;
      activeTracks: number;
      lastGetUserMediaAdmissionAtMs: number | null;
      lastCaptureFirstTrackStopAtMs: number | null;
      constraints: unknown[];
      recordingBlobs: Array<{ size: number; type: string }>;
      blobFetches: Array<{ ok: boolean; size: number | null; type: string | null }>;
      objectUrlCreates: number;
      objectUrlRevokes: number;
      activeObjectUrls: number;
      getUserMediaErrors: Array<{ name: string; message: string }>;
      instrumentationErrors: Array<{ stage: string }>;
    };
    const globalWithQa = window as typeof window & { __happierVoiceMediaQa?: QaState };
    const qa: QaState = {
      calls: 0,
      stoppedTracks: 0,
      maxInputLevel: 0,
      activeTracks: 0,
      lastGetUserMediaAdmissionAtMs: null,
      lastCaptureFirstTrackStopAtMs: null,
      constraints: [],
      recordingBlobs: [],
      blobFetches: [],
      objectUrlCreates: 0,
      objectUrlRevokes: 0,
      activeObjectUrls: 0,
      getUserMediaErrors: [],
      instrumentationErrors: [],
    };
    globalWithQa.__happierVoiceMediaQa = qa;
    let currentCaptureToken: symbol | null = null;
    const ownedObjectUrls = new Set<string>();
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const objectUrl = originalCreateObjectUrl(object);
      ownedObjectUrls.add(objectUrl);
      qa.objectUrlCreates += 1;
      qa.activeObjectUrls = ownedObjectUrls.size;
      if (object instanceof Blob) {
        qa.recordingBlobs.push({ size: object.size, type: object.type });
      }
      return objectUrl;
    };
    URL.revokeObjectURL = (objectUrl: string) => {
      originalRevokeObjectUrl(objectUrl);
      if (ownedObjectUrls.delete(objectUrl)) {
        qa.objectUrlRevokes += 1;
        qa.activeObjectUrls = ownedObjectUrls.size;
      }
    };
    const originalFetch = window.fetch.bind(window);
    const instrumentedFetch = (...args: Parameters<typeof window.fetch>) => {
      const requestUrl = typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof URL
          ? args[0].toString()
          : args[0].url;
      if (!requestUrl.startsWith('blob:')) return originalFetch(...args);
      return originalFetch(...args).then(
        (response) => {
          // Observation must not delay or reject the real recording fetch. The
          // clone is diagnostic-only and its entire failure path is consumed.
          void Promise.resolve()
            .then(() => response.clone().blob())
            .then((blob) => {
              qa.blobFetches.push({ ok: response.ok, size: blob.size, type: blob.type });
            })
            .catch(() => {
              qa.blobFetches.push({ ok: false, size: null, type: null });
            });
          return response;
        },
        (error) => {
          qa.blobFetches.push({ ok: false, size: null, type: null });
          throw error;
        },
      );
    };
    // `window.fetch` is augmented by both DOM and React Native test types in
    // this package. Define the runtime property directly so this browser-only
    // init script does not have to falsely collapse those overload sets.
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: instrumentedFetch,
    });
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) return;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
      qa.calls += 1;
      qa.constraints.push(constraints);
      let stream: MediaStream;
      try {
        stream = await original(constraints);
      } catch (error) {
        qa.getUserMediaErrors.push({
          name: error instanceof DOMException || error instanceof Error
            ? error.name
            : 'UnknownError',
          message: error instanceof DOMException || error instanceof Error
            ? error.message
            : String(error),
        });
        throw error;
      }
      qa.lastGetUserMediaAdmissionAtMs = performance.now();
      qa.lastCaptureFirstTrackStopAtMs = null;
      const captureToken = Symbol('voice-media-capture');
      currentCaptureToken = captureToken;
      const tracks = stream.getAudioTracks();
      qa.activeTracks += tracks.filter((track) => track.readyState === 'live').length;
      for (const track of tracks) {
        const originalStop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState === 'live') {
            if (currentCaptureToken === captureToken && qa.lastCaptureFirstTrackStopAtMs === null) {
              qa.lastCaptureFirstTrackStopAtMs = performance.now();
            }
            qa.stoppedTracks += 1;
            qa.activeTracks = Math.max(0, qa.activeTracks - 1);
          }
          originalStop();
        };
      }

      const AudioContextCtor = window.AudioContext;
      if (AudioContextCtor) {
        // QA observation must never become an authority over the production stream. Run its
        // separate analyser graph best-effort and preserve only a stable diagnostic stage.
        void (async () => {
          let context: AudioContext | null = null;
          let source: MediaStreamAudioSourceNode | null = null;
          let analyser: AnalyserNode | null = null;
          const closeContext = (): void => {
            try { source?.disconnect(); } catch {}
            try { analyser?.disconnect(); } catch {}
            if (context) void context.close().catch(() => {});
          };
          try {
            context = new AudioContextCtor();
          } catch {
            qa.instrumentationErrors.push({ stage: 'audio_context_create' });
            return;
          }
          try {
            if (context.state === 'suspended') await context.resume();
          } catch {
            qa.instrumentationErrors.push({ stage: 'audio_context_resume' });
            closeContext();
            return;
          }
          try {
            source = context.createMediaStreamSource(stream);
            analyser = context.createAnalyser();
            analyser.fftSize = 1024;
            source.connect(analyser);
          } catch {
            qa.instrumentationErrors.push({ stage: 'analyser_connect' });
            closeContext();
            return;
          }
          const samples = new Uint8Array(analyser.fftSize);
          const sample = () => {
            const live = tracks.some((track) => track.readyState === 'live');
            if (!live) {
              closeContext();
              return;
            }
            try {
              analyser?.getByteTimeDomainData(samples);
            } catch {
              qa.instrumentationErrors.push({ stage: 'analyser_sample' });
              closeContext();
              return;
            }
            let energy = 0;
            for (const sampleByte of samples) {
              const centered = (sampleByte - 128) / 128;
              energy += centered * centered;
            }
            qa.maxInputLevel = Math.max(qa.maxInputLevel, Math.sqrt(energy / samples.length));
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        })();
      }
      return stream;
    };
  });
}

async function installLocalMediaSettings(params: Readonly<{
  authToken: string;
  baseUrl: string;
  machineId: string;
  accountSettingsMaterial: AccountScopedCryptoMaterial;
  sttBaseUrl?: string | null;
  daemonSttModelPackId?: string | null;
  conversationMode?: 'direct_session' | 'agent';
}>): Promise<void> {
  const daemonSttModelPackId = params.daemonSttModelPackId?.trim() || null;
  const openAiCompatBaseUrl = params.sttBaseUrl ?? '';
  const conversationMode = params.conversationMode ?? 'direct_session';
  const nextVoice = {
    providerId: 'local_conversation',
    assistantLanguage: 'en',
    ...(daemonSttModelPackId
      ? {
          dictation: {
            sttBinding: 'explicit',
            language: 'en',
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: daemonSttModelPackId,
                language: 'en',
                execution: 'daemon',
              },
            },
          },
        }
      : {}),
    executionMachine: {
      mode: 'fixed',
      machineId: params.machineId,
      autoMachineId: null,
    },
    providers: {
      local_conversation: {
        schemaVersion: 1,
        config: {
          conversationMode,
          handsFree: { enabled: false },
          stt: {
            provider: daemonSttModelPackId ? 'local_neural' : OPENAI_COMPAT_STT_PROVIDER_ID,
            localNeural: {
              assetId: daemonSttModelPackId,
              language: 'en',
              execution: 'daemon',
            },
          },
          tts: {
            provider: 'device',
            autoSpeakReplies: false,
            bargeInEnabled: true,
          },
          agent: {
            ...(conversationMode === 'agent'
              ? {
                  agentSource: 'agent' as const,
                  agentId: 'claude',
                  prewarmOnConnect: false,
                }
              : {}),
            chatModelSource: 'custom',
            chatModelId: 'voice-qa-chat',
            commitModelSource: 'chat',
            commitModelId: 'voice-qa-chat',
            providerChat: null,
          },
        },
      },
      [OPENAI_COMPAT_STT_PROVIDER_ID]: {
        schemaVersion: 2,
        config: {
          baseUrl: openAiCompatBaseUrl,
          insecureLocalOriginConsent: params.sttBaseUrl ? new URL(params.sttBaseUrl).origin : '',
          insecureLocalConsentMachineId: params.machineId,
          model: 'whisper-1',
          language: 'en',
        },
      },
    },
  };
  await upsertEncryptedAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.authToken,
    material: params.accountSettingsMaterial,
    settings: {
      experiments: true,
      featureToggles: {
        voice: true,
        'voice.agent': true,
        'voice.daemonInference': true,
        'execution.runs': true,
      },
      voice: nextVoice,
    },
  });
}

/**
 * Test-only account-settings setup for a normal Local Agent Voice attempt.
 *
 * It deliberately reuses the same encrypted settings writer and OpenAI-compatible
 * STT boundary as the media harness; callers still drive capture through the
 * real Voice surface rather than the `/dev/voice-qa` screen.
 */
export async function installLocalAgentVoiceSettings(params: Readonly<{
  authToken: string;
  baseUrl: string;
  machineId: string;
  accountSettingsMaterial: AccountScopedCryptoMaterial;
  sttBaseUrl: string;
}>): Promise<void> {
  if (!params.sttBaseUrl.trim()) {
    throw new Error('voice_local_agent_stt_base_url_required');
  }
  await installLocalMediaSettings({
    ...params,
    conversationMode: 'agent',
  });
}

export async function prepareVoiceBrowserQaPage(params: Readonly<{
  page: Page;
  stack: VoiceBrowserQaStack;
  routeQuery: Readonly<Record<string, string>>;
  sttBaseUrl?: string | null;
  daemonSttModelPackId?: string | null;
}>): Promise<Readonly<{ sessionId: string }>> {
  const sessionId = await params.stack.createRunnableSession();
  // Seed the authoritative encrypted account settings before browser sync
  // starts. A browser-cache-only mutation races the authenticated settings
  // fetch and can switch the provider off between capture start and stop.
  await installLocalMediaSettings({
    authToken: params.stack.authToken,
    baseUrl: params.stack.server.baseUrl,
    machineId: params.stack.machineId,
    accountSettingsMaterial: params.stack.accountSettingsMaterial,
    sttBaseUrl: params.sttBaseUrl,
    daemonSttModelPackId: params.daemonSttModelPackId,
  });
  await installAuthBootstrapStorageSnapshot(
    params.page,
    params.stack.authBootstrapSnapshot,
  );
  await installVoiceMediaInstrumentation(params.page);

  const url = new URL('/dev/voice-qa', `${params.stack.uiBaseUrl}/`);
  url.searchParams.set('happier_hmr', '0');
  for (const [key, value] of Object.entries(params.routeQuery)) {
    url.searchParams.set(key, value);
  }
  await gotoDomContentLoadedWithPathFallback(params.page, url.toString(), '/dev/voice-qa', 300_000);
  await waitForAuthenticatedRouteUi({
    page: params.page,
    expectedPathname: '/dev/voice-qa',
    requiredTestIds: ['voiceQa.sessionIdInput', 'voiceQa.start', 'voiceQa.stop', 'voiceQa.media.snapshot'],
    blockedTestIds: ['welcome-create-account'],
    timeoutMs: 300_000,
  });
  const browserFeatures = await params.page.evaluate(async (serverBaseUrl) => {
    const response = await fetch(new URL('/v1/features', `${serverBaseUrl}/`).toString());
    if (!response.ok) throw new Error(`browser feature preflight failed: HTTP ${response.status}`);
    return await response.json() as FeaturesResponse;
  }, params.stack.server.baseUrl);
  assertVoiceQaRouteProfile(
    browserFeatures,
    'browser',
    params.stack.routeProfile,
    params.stack.daemonControlPort,
  );
  // Rendering the authenticated route is not equivalent to account-settings
  // and machine hydration. Starting media before both canonical owners settle
  // races the encrypted settings fetch: the lifecycle controller can briefly
  // be configured with `null`, then switch providers between Start and Stop.
  // Wait at the dev-only evidence boundary so Q2 always exercises one stable,
  // authoritative provider + execution-machine configuration.
  await expect.poll(async () => {
    const raw = await params.page.getByTestId('voiceQa.media.snapshot').textContent();
    try {
      return JSON.parse(raw ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }, {
    message: 'voice QA canonical settings and execution machine did not hydrate',
    timeout: 180_000,
  }).toMatchObject({
    configuredProviderId: 'local_conversation',
    executionMachineId: params.stack.machineId,
    localSttProvider: params.daemonSttModelPackId ? 'local_neural' : OPENAI_COMPAT_STT_PROVIDER_ID,
    localSttModelPackId: params.daemonSttModelPackId ?? null,
    localSttBaseUrlConfigured: params.daemonSttModelPackId
      ? false
      : Boolean(params.sttBaseUrl),
    machineControlPortAuthorized: true,
    ...(params.stack.routeProfile === 'direct'
      ? { directLoopbackEndpointReady: true }
      : {
          accountProfileReady: true,
          activeServerSocketReady: true,
        }),
    serverRoute: {
      rpcDirectPeerEnabled: params.stack.routeProfile === 'direct',
    },
  });
  const hydratedSnapshotRaw = await params.page.getByTestId('voiceQa.media.snapshot').textContent();
  const hydratedSnapshot = JSON.parse(hydratedSnapshotRaw ?? '{}') as {
    serverRoute?: { activeServerUrl?: unknown };
  };
  expect(normalizeLoopbackBaseUrl(String(hydratedSnapshot.serverRoute?.activeServerUrl ?? ''))).toBe(
    normalizeLoopbackBaseUrl(params.stack.server.baseUrl),
  );
  await params.page.getByTestId('voiceQa.sessionIdInput').fill(sessionId);
  return { sessionId };
}

export type VoiceQaBoundaryServer = Readonly<{
  baseUrl: string;
  stop: () => Promise<void>;
  getRequests: () => readonly VoiceQaBoundaryRequest[];
  getTranscriptionRequestCount: () => number;
  getLastTranscriptionRequest: () => Readonly<{
    contentType: string;
    bodyByteLength: number;
  }> | null;
}>;

export type VoiceQaBoundaryRequest = Readonly<{
  operation: 'transcription' | 'chat' | 'speech';
  authorization: string;
  contentType: string;
  bodyByteLength: number;
  bodyText: string | null;
}>;

export async function startVoiceQaBoundaryServer(params: Readonly<{
  requiredAuthorization?: Partial<Record<VoiceQaBoundaryRequest['operation'], string>>;
  /**
   * Per-capture STT replies for a deterministic browser scenario. This is fixed
   * at server construction; there is intentionally no mutable test endpoint.
   */
  transcriptionTexts?: readonly string[];
}> = {}): Promise<VoiceQaBoundaryServer> {
  const fixture = await readFile(
    resolve(repoRootDir(), 'packages/tests/fixtures/voice/phrases/short-command.24k.wav'),
  );
  const transcriptionTexts = params.transcriptionTexts === undefined
    ? ['check repository status']
    : params.transcriptionTexts
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
  if (transcriptionTexts.length === 0) {
    throw new Error('voice_qa_boundary_transcription_text_required');
  }
  let transcriptionRequests = 0;
  const requests: VoiceQaBoundaryRequest[] = [];
  let lastTranscriptionRequest: Readonly<{
    contentType: string;
    bodyByteLength: number;
  }> | null = null;
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/audio.wav') {
      response.statusCode = 200;
      response.setHeader('content-type', 'audio/wav');
      response.setHeader('content-length', String(fixture.byteLength));
      response.end(fixture);
      return;
    }
    const operation = request.method === 'POST'
      ? request.url === '/v1/audio/transcriptions'
        ? 'transcription'
        : request.url === '/v1/chat/completions'
          ? 'chat'
          : request.url === '/v1/audio/speech'
            ? 'speech'
            : null
      : null;
    if (operation) {
      const requiredAuthorization = params.requiredAuthorization?.[operation];
      if (
        requiredAuthorization
        && String(request.headers.authorization ?? '') !== requiredAuthorization
      ) {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (operation === 'transcription') transcriptionRequests += 1;
      const chunks: Buffer[] = [];
      let bodyByteLength = 0;
      let rejectedForSize = false;
      request.on('data', (chunk: Buffer) => {
        bodyByteLength += chunk.byteLength;
        if (bodyByteLength > 8 * 1024 * 1024) {
          rejectedForSize = true;
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      request.once('end', () => {
        if (rejectedForSize) {
          response.statusCode = 413;
          response.end('too large');
          return;
        }
        const body = Buffer.concat(chunks);
        const contentType = String(request.headers['content-type'] ?? '');
        requests.push({
          operation,
          authorization: String(request.headers.authorization ?? ''),
          contentType,
          bodyByteLength: body.byteLength,
          bodyText: operation === 'transcription' ? null : body.toString('utf8'),
        });
        if (operation === 'transcription') {
          // Retain only bounded request metadata. The body is consumed so Q2
          // proves that real captured media crossed the provider boundary, but
          // voice bytes are not persisted in test state or evidence.
          lastTranscriptionRequest = {
            contentType,
            bodyByteLength: body.byteLength,
          };
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            text: transcriptionTexts[Math.min(transcriptionRequests - 1, transcriptionTexts.length - 1)],
          }));
          return;
        }
        if (operation === 'chat') {
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            choices: [{ message: { content: 'The repository status is ready.' } }],
          }));
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'audio/wav');
        response.setHeader('content-length', String(fixture.byteLength));
        response.end(fixture);
      });
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('voice_qa_boundary_server_address_missing');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
    getRequests: () => requests.map((request) => ({ ...request })),
    getTranscriptionRequestCount: () => transcriptionRequests,
    getLastTranscriptionRequest: () => lastTranscriptionRequest,
  };
}
