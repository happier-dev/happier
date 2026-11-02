import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ManagedEnrollmentCorrelationV1Schema, type ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { ManagedMachineEnrollmentIdentityV1Schema, type ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import {
  assertResolvedHomeTargetIdentity,
  createTransferableHomeTargetInput,
  parseResolvedHomeTarget,
  type ResolvedHomeTarget,
} from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor } from '../executors/happierJsonExecutor.js';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from '../executors/enrollMachineFlowExecutor.js';
import { resolveDaemonServiceInstallConflictPlan } from '../../happierRuntime/daemonInstallConflict.js';
import type { HappierService, HappierServicePlatform } from '../../happierRuntime/types.js';
import { resolveDaemonServiceBackend } from '../setupServiceGuidance/buildBackgroundServiceSetupGuidance.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import {
  redactSensitiveSystemTaskJsonValue,
  type InteractiveSystemTaskContext,
  type InteractiveSystemTaskKind,
} from '../interactiveTaskKinds.js';
import {
  resolveEnrollMachineReadiness,
  runEnrollMachineFlow,
  type EnrollMachineFlowExecutor,
} from '../flows/enrollMachineFlow.js';
import { runRemoteHomeEnrollmentFlow } from '../flows/remoteHomeEnrollmentFlow.js';
import {
  createRemoteEnrollMachineFlowHappierExecutor,
  createEnrollMachineFlowExecutorFromRemoteCommandRunner,
  normalizeRemoteBootstrapCliJsonResult,
} from '../executors/remoteEnrollMachineFlowExecutor.js';
import {
  parseSystemTaskSshConfig,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from './relayRuntimeKinds.js';

type RemoteCommandResult = Readonly<{
  ok: boolean;
  data: Record<string, unknown>;
}>;

export type RemoteBootstrapExistingDaemonServiceSummary = Readonly<{
  label: string;
  releaseChannel: 'stable' | 'preview' | 'dev' | null;
  targetMode: 'default-following' | 'pinned' | null;
  running: boolean;
}>;

type CanonicalRemoteHostTrustPromptKind = 'ssh.trustHost' | 'ssh.replaceHostKey';
type RemoteHostTrustPromptKind = CanonicalRemoteHostTrustPromptKind | 'sshHostTrust';

export type RemoteSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

export type RemoteSshBootstrapHappierJsonExecutor = Readonly<{
  runHappierJson: (params: Readonly<{ args: readonly string[] }>) => Promise<RemoteCommandResult>;
}>;

function isLoopbackRelayUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return isLoopbackHostname(hostname)
      || normalizeHostnameForLoopbackCheck(hostname) === '0.0.0.0';
  } catch {
    return false;
  }
}

function resolveRelayRuntimeRelayUrlFromInstallResult(
  installResult: Record<string, unknown>,
  fallbackRelayUrl: string,
): string {
  const relayUrl = typeof installResult.relayUrl === 'string' ? installResult.relayUrl.trim() : '';
  if (relayUrl) {
    return relayUrl;
  }

  const serverUrl = typeof installResult.serverUrl === 'string' ? installResult.serverUrl.trim() : '';
  if (serverUrl) {
    return serverUrl;
  }

  const serverPortRaw = installResult.serverPort;
  const serverPort = typeof serverPortRaw === 'number'
    ? serverPortRaw
    : (typeof serverPortRaw === 'string'
        ? Number.parseInt(serverPortRaw.trim(), 10)
        : Number.NaN);
  if (Number.isInteger(serverPort) && serverPort > 0 && serverPort <= 65535) {
    return `http://127.0.0.1:${serverPort}`;
  }

  return fallbackRelayUrl;
}

function deriveWebappUrl(serverUrl: string, explicitWebappUrl?: string): string {
  if (typeof explicitWebappUrl === 'string' && explicitWebappUrl.trim()) {
    return explicitWebappUrl.trim();
  }
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

function shouldIgnoreLocalApprovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return false;
  return /not authenticated/i.test(message);
}

export function summarizeDiscoveredRemoteDaemonServices(data: Record<string, unknown>): RemoteBootstrapExistingDaemonServiceSummary[] {
  const rawServices = Array.isArray(data.services) ? data.services : [];
  return rawServices.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (record.serviceType !== 'daemon') {
      return [];
    }
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label) {
      return [];
    }
    const releaseChannel = normalizePublicReleaseRingLabel(record.ring) || null;
    const targetMode =
      record.targetMode === 'default-following' || record.targetMode === 'pinned'
        ? record.targetMode
        : null;
    return [{
      label,
      releaseChannel,
      targetMode,
      running: record.running === true,
    }];
  });
}

/**
 * The one remedy for `service_reconciliation_declined`, shared by machine setup
 * and Home creation. It names no host-specific control or flag, so it stays
 * true in the CLI prompt and in the app's replace prompt alike.
 */
export const SERVICE_RECONCILIATION_DECLINED_MESSAGE =
  'Existing background services on the remote host were left unchanged, so setup stopped. Start again and choose to replace them.';

function readRemoteServicePlatform(value: unknown): HappierServicePlatform | null {
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : null;
}

/**
 * Whether the remote host's installed daemon services conflict with the service
 * this setup is about to install, decided by the one canonical install conflict
 * plan over the remote `service list --json` inventory. Every listed service
 * lives on the same remote host, so an entry that omits its platform shares
 * the host platform. The inventory carries no Happier home directory, so
 * foreign-home detection stays with the remote CLI's own install/setup owner.
 */
function remoteDaemonServicesConflictWithInstallTarget(params: Readonly<{
  data: Record<string, unknown>;
  targetReleaseChannel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
}>): boolean {
  const entries = (Array.isArray(params.data.services) ? params.data.services : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => entry.serviceType === 'daemon');
  if (entries.length === 0) return false;
  const platform = entries.map((entry) => readRemoteServicePlatform(entry.platform)).find((value) => value !== null) ?? 'linux';
  const services = entries.map((entry, index): HappierService => {
    const mode = entry.mode === 'system' ? 'system' : 'user';
    const path = typeof entry.path === 'string' ? entry.path : '';
    const relayUrl = typeof entry.relayUrl === 'string' && entry.relayUrl.trim() ? entry.relayUrl.trim() : null;
    return {
      id: path || `remote-daemon-service-${index}`,
      serviceType: 'daemon',
      platform,
      backend: resolveDaemonServiceBackend(platform, mode),
      label: typeof entry.label === 'string' ? entry.label : '',
      ...(entry.targetMode === 'default-following' || entry.targetMode === 'pinned' ? { targetMode: entry.targetMode } : {}),
      verification: 'verified',
      ring: normalizePublicReleaseRingLabel(entry.ring) || null,
      instanceId: typeof entry.serverId === 'string' && entry.serverId.trim() ? entry.serverId.trim() : null,
      scope: mode,
      definitionPath: path,
      executablePath: null,
      serverUrl: relayUrl,
      publicServerUrl: relayUrl,
      installed: true,
      running: entry.running === true,
    };
  });
  return resolveDaemonServiceInstallConflictPlan({
    target: {
      platform,
      backend: resolveDaemonServiceBackend(platform, params.mode),
      targetMode: 'default-following',
      ring: params.targetReleaseChannel,
      instanceId: null,
      serverUrl: null,
      happierHomeDir: null,
    },
    strategy: 'require-explicit',
    services,
  }).competingServices.length > 0;
}

/**
 * The single remote background-service replacement preflight shared by machine
 * setup and remote Home creation: read the remote inventory (tolerating an older
 * or failing `service list`), decide through the canonical conflict plan, ask
 * once, and refuse with the typed reconciliation error when declined. Returns
 * whether the caller must apply the accepted replacement.
 */
export async function preflightRemoteBackgroundServiceReplacement(params: Readonly<{
  ctx: Pick<InteractiveSystemTaskContext, 'prompt'>;
  listServices: () => Promise<Record<string, unknown>>;
  targetReleaseChannel: 'stable' | 'preview' | 'dev';
  targetServerUrl: string | null;
  mode: 'user' | 'system';
  stepId: string;
}>): Promise<boolean> {
  let data: Record<string, unknown>;
  try {
    data = await params.listServices();
  } catch {
    // The remote install/setup owner still returns its exact typed failure.
    return false;
  }
  if (!remoteDaemonServicesConflictWithInstallTarget({
    data,
    targetReleaseChannel: params.targetReleaseChannel,
    mode: params.mode,
  })) {
    return false;
  }
  const answer = await params.ctx.prompt({
    kind: 'daemon.replaceRemoteBackgroundServices',
    stepId: params.stepId,
    message: 'Remote machine already has Happier background services. Replace them with the selected release channel?',
    data: {
      targetServerUrl: params.targetServerUrl,
      targetReleaseChannel: params.targetReleaseChannel,
      services: summarizeDiscoveredRemoteDaemonServices(data),
    },
  }) as { replaceExistingServices?: boolean } | null;
  if (answer?.replaceExistingServices !== true) {
    throw new SystemTaskExecutionError('service_reconciliation_declined', SERVICE_RECONCILIATION_DECLINED_MESSAGE);
  }
  return true;
}

export interface RemoteBootstrapMachineParams {
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string;
  relay: Readonly<{
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
  }>;
  homeTarget?: ResolvedHomeTarget;
  managedEnrollment?: ManagedEnrollmentCorrelationV1;
  /** Initial managed-guest presentation, not an update to an incumbent Machine name. */
  machineDisplayName?: string;
  enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
  requireLocalApproval?: boolean;
  channel?: 'stable' | 'preview' | 'dev';
  serviceMode?: 'user' | 'none';
  knownHostsMode?: 'app' | 'system';
  relayRuntime?: Readonly<{
    enabled: boolean;
    mode?: 'user' | 'system';
    switchRelayUrl?: boolean;
    env?: Record<string, string>;
    selfHostRelayBinaryOverride?: string;
  }>;
  promptResolution?: Readonly<{
    hostTrust?: Readonly<{
      kind: 'ssh.trustHost' | 'ssh.replaceHostKey';
      fingerprint: string;
      existingFingerprint?: string | null;
    }>;
    authApproval?: Readonly<{
      publicKey: string;
    }>;
  }>;
}

export type RemoteHostTrustResolution =
  | Readonly<{ status: 'trusted' }>
  | Readonly<{
      status: 'prompt';
      promptKind: RemoteHostTrustPromptKind;
      promptMessage: string;
      promptData: SystemTaskJsonObject;
      accept: () => Promise<void>;
      decline?: () => Promise<void>;
    }>;

export type RemoteSshBootstrapMachineDeps = Readonly<{
  /** In-process admitted Create or Retry; public task params cannot supply this proof. */
  reviewedChild?: HostReviewedChildPortV1;
  /** Host SSH transports materialize keys; native transports keep them in memory. */
  materializeIdentityPrivateKey?: (params: Readonly<{ privateKey: string; prefix?: string }>) => Promise<Readonly<{
    identityFilePath: string;
    cleanup: () => Promise<void>;
  }>>;
  onEnrollmentDeadline?: (deadlineMs: number) => void;
  /** Recheck once before pairing approval can register the guest. */
  assertManagedEnrollmentCurrent?: (correlation: ManagedEnrollmentCorrelationV1) => Promise<void>;
  /** Current requesting client's approval replaces local sealing; context stays only in this closure. */
  deliverAuthApproval?: (input: Readonly<{
    request: unknown; publicKey: string; homeServerIdentityId: string; pairing?: unknown;
    supportsTokenOnly?: boolean; signal?: AbortSignal;
  }>) => Promise<SystemTaskJsonValue>;
  resolveHostTrust: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    signal?: AbortSignal;
  }>) => Promise<RemoteHostTrustResolution>;
  installRemoteCli: (params: Readonly<{
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    context?: Pick<InteractiveSystemTaskContext, 'taskId' | 'emit' | 'prompt'>;
    signal?: AbortSignal;
  }>) => Promise<void>;
  approveLocalAuthRequest: (params: Readonly<{
    publicKey: string;
    homeServerIdentityId: string;
    parsed: RemoteBootstrapMachineParams;
    // Verbatim short-lived v3 pairing context plus the requester's
    // token-only capability, forwarded so the local approval seals a
    // pairing-bound v3 response. The approval owner validates them; this seam
    // never fabricates pairing material.
    pairing?: unknown;
    supportsTokenOnly?: boolean;
    signal?: AbortSignal;
  }>) => Promise<void>;
  createHappierJsonExecutor?: (params: Readonly<{
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    localServerUrl?: string;
    signal?: AbortSignal;
  }>) => RemoteSshBootstrapHappierJsonExecutor;
  createRemoteEnrollmentExecutor?: (params: Readonly<{
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    signal?: AbortSignal;
  }>) => HappierJsonExecutor;
  runRemoteCommand: (params: Readonly<{
    label:
      | 'auth.status'
      | 'daemon.status'
      | 'server.configure'
      | 'daemon.service.list'
      | 'daemon.service.install'
      | 'daemon.service.uninstallAll'
      | 'daemon.service.start'
      | 'relay.runtime.install';
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    data?: Record<string, unknown>;
    signal?: AbortSignal;
  }>) => Promise<RemoteCommandResult>;
}>;

export function createRemoteSshBootstrapMachineTaskKind(
  deps: RemoteSshBootstrapMachineDeps,
): InteractiveSystemTaskKind<Readonly<{
  publicKey?: string;
  machineId: string | null;
  relayRuntime?: Readonly<{
    relayUrl: string;
    mode: 'user' | 'system';
  }>;
}>> {
  return {
    async run(ctx) {
      const runRemoteCommand: RemoteSshBootstrapMachineDeps['runRemoteCommand'] = async (params) => {
        ctx.signal?.throwIfAborted();
        return await deps.runRemoteCommand({ ...params, signal: ctx.signal });
      };
      const installRemoteCli: RemoteSshBootstrapMachineDeps['installRemoteCli'] = async (params) => {
        ctx.signal?.throwIfAborted();
        await deps.installRemoteCli({ ...params, signal: ctx.signal, context: ctx });
      };
      let cleanupTempIdentityFile: (() => Promise<void>) | null = null;
      try {
        const parsedRaw = parseRemoteBootstrapMachineParams(ctx.params);
        const publicRelayUrl = typeof parsedRaw.relay.publicRelayUrl === 'string'
          ? parsedRaw.relay.publicRelayUrl.trim()
          : '';
        const remoteRelayUrl = publicRelayUrl || parsedRaw.relay.relayUrl;
        const shouldPreferInstalledRelayRuntimeAsLocalServerUrl =
          Boolean(publicRelayUrl) || isLoopbackRelayUrl(parsedRaw.relay.relayUrl);
        let parsedRemote = remoteRelayUrl && remoteRelayUrl !== parsedRaw.relay.relayUrl
          ? {
              ...parsedRaw,
              relay: {
                ...parsedRaw.relay,
                relayUrl: remoteRelayUrl,
              },
            }
          : parsedRaw;
        let parsedLocalForApproval = parsedRaw;

        const relayRuntimeEnabled = parsedRemote.relayRuntime?.enabled === true;
        if (
          isLoopbackRelayUrl(parsedRemote.relay.relayUrl)
          && !relayRuntimeEnabled
          && !parsedRemote.homeTarget?.descriptor
        ) {
          throw new SystemTaskExecutionError(
            'relay_url_unreachable',
            'Remote setup cannot use a loopback Relay URL. Provide relay.publicRelayUrl.',
          );
        }
        const knownHostsMode = parsedRemote.knownHostsMode ?? 'app';
        const authResolution = await resolveRemoteSshAuth({
          ctx,
          parsedRemote,
          materializeIdentityPrivateKey: deps.materializeIdentityPrivateKey,
        });
        cleanupTempIdentityFile = authResolution.cleanup;
        const auth = authResolution.auth;

        ctx.emit({
          type: 'progress',
          stepId: 'ssh.trust',
          message: 'Verifying SSH host trust',
        });

      const trustResolution = await deps.resolveHostTrust({
        ssh: parsedRemote.ssh,
        knownHostsMode,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const trust = trustResolution.status === 'prompt'
        ? normalizeRemoteHostTrustResolution(trustResolution)
        : trustResolution;

      if (trust.status === 'prompt') {
        if (shouldAutoAcceptHostTrust(parsedRemote, trust)) {
          await trust.accept();
        } else {
          const answer = await ctx.prompt({
            kind: trust.promptKind,
            stepId: 'ssh.hostTrust',
            message: trust.promptMessage,
            data: trust.promptData,
          }) as { trusted?: boolean };
          if (answer?.trusted !== true) {
            await trust.decline?.();
            throw new SystemTaskExecutionError('host_trust_declined', 'SSH host trust was declined.');
          }
          await trust.accept();
        }
      }

        ctx.emit({
          type: 'progress',
          stepId: 'ssh.installCli',
          message: 'Ensuring Happier is installed on the remote machine',
        });
        await installRemoteCli({ parsed: parsedRemote, auth, knownHostsMode });

        let relayRuntime: Readonly<{ relayUrl: string; mode: 'user' | 'system' }> | undefined;
        let relayRuntimeLocalServerUrl: string | undefined;
        if (parsedRemote.relayRuntime?.enabled === true) {
        ctx.emit({
          type: 'progress',
          stepId: 'relay.runtime.install',
          message: 'Installing relay runtime on the remote machine',
        });

        const relayInstall = requireOk(
          await runRemoteCommand({
            label: 'relay.runtime.install',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
          }),
          'relay.runtime.install',
        );

        relayRuntime = {
          relayUrl: resolveRelayRuntimeRelayUrlFromInstallResult(relayInstall, parsedRemote.relay.relayUrl),
          mode: parsedRemote.relayRuntime.mode ?? 'user',
        };
        const shouldSwitchLoopbackRelayUrlToInstalledRuntime =
          !publicRelayUrl
          && isLoopbackRelayUrl(parsedRaw.relay.relayUrl)
          && isLoopbackRelayUrl(relayRuntime.relayUrl)
          && relayRuntime.relayUrl !== parsedRaw.relay.relayUrl;

        if (shouldSwitchLoopbackRelayUrlToInstalledRuntime) {
          parsedRemote = {
            ...parsedRemote,
            relay: {
              ...parsedRemote.relay,
              relayUrl: relayRuntime.relayUrl,
            },
          };
          parsedLocalForApproval = {
            ...parsedLocalForApproval,
            relay: {
              ...parsedLocalForApproval.relay,
              relayUrl: relayRuntime.relayUrl,
            },
          };
          relayRuntimeLocalServerUrl = undefined;
        } else {
          relayRuntimeLocalServerUrl = shouldPreferInstalledRelayRuntimeAsLocalServerUrl
            ? relayRuntime.relayUrl
            : undefined;
        }

        if (parsedRemote.relayRuntime?.switchRelayUrl === true && publicRelayUrl) {
          const canonicalRemoteRelayUrl = parsedRemote.relay.relayUrl;
          parsedLocalForApproval = {
            ...parsedLocalForApproval,
            relay: {
              ...parsedLocalForApproval.relay,
              relayUrl: relayRuntime.relayUrl,
              ...(canonicalRemoteRelayUrl && canonicalRemoteRelayUrl !== relayRuntime.relayUrl
                ? { publicRelayUrl: canonicalRemoteRelayUrl }
                : {}),
            },
          };
        }
      }

      const webappUrl = deriveWebappUrl(parsedRemote.relay.relayUrl, parsedRemote.relay.webappUrl);

      const relayProfile = {
        serverUrl: parsedRemote.relay.relayUrl,
        webappUrl,
        localServerUrl: relayRuntimeLocalServerUrl ?? null,
      } as const;

      const remoteHappierExecutor = createRemoteEnrollMachineFlowHappierExecutor({
        parsed: parsedRemote,
        auth,
        knownHostsMode,
        ...(relayRuntimeLocalServerUrl ? { localServerUrl: relayRuntimeLocalServerUrl } : {}),
        runRemoteCommand,
        signal: ctx.signal,
        ...(deps.createHappierJsonExecutor ? { createHappierJsonExecutor: deps.createHappierJsonExecutor } : {}),
      });

      const serviceFlowExecutor = createEnrollMachineFlowExecutorFromRemoteCommandRunner({
        parsed: parsedRemote,
        auth,
        knownHostsMode,
        ...(relayRuntimeLocalServerUrl ? { localServerUrl: relayRuntimeLocalServerUrl } : {}),
        serviceMode: parsedRemote.serviceMode ?? 'user',
        runRemoteCommand,
        signal: ctx.signal,
        ...(deps.createHappierJsonExecutor ? { createHappierJsonExecutor: deps.createHappierJsonExecutor } : {}),
      });
      return await runRemoteMachineBootstrapRecipe({
        ctx, parsedRemote, parsedLocalForApproval, relayRuntime, relayRuntimeLocalServerUrl,
        onEnrollmentDeadline: deps.onEnrollmentDeadline,
        remoteHappierExecutor, serviceFlowExecutor,
        createRemoteEnrollmentExecutor: () => deps.createRemoteEnrollmentExecutor?.({
          parsed: parsedRemote, auth, knownHostsMode, signal: ctx.signal,
        }),
        approveLocalAuthRequest: (request) => deps.approveLocalAuthRequest({ ...request, parsed: parsedLocalForApproval }),
        deliverAuthApproval: deps.deliverAuthApproval,
        reviewedChild: deps.reviewedChild,
        assertCurrent: parsedRemote.managedEnrollment
          ? async () => {
              if (!deps.assertManagedEnrollmentCurrent) throw new SystemTaskExecutionError('managed_enrollment_unavailable', 'Managed enrollment requires current host admission.');
              await deps.assertManagedEnrollmentCurrent(parsedRemote.managedEnrollment!);
            }
          : undefined,
      });
      } finally {
        await cleanupTempIdentityFile?.().catch(() => {});
      }
    },
  };
}

export function parseRemoteBootstrapMachineParams(params: unknown): RemoteBootstrapMachineParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote bootstrap params.');
  }
  const value = params as Record<string, unknown>;
  const relay = value.relay;
  if (!relay || typeof relay !== 'object' || Array.isArray(relay)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote relay config.');
  }
  const relayRecord = relay as Record<string, unknown>;
  const relayRuntimeRaw = value.relayRuntime;
  const relayRuntime = relayRuntimeRaw && typeof relayRuntimeRaw === 'object' && !Array.isArray(relayRuntimeRaw)
    ? relayRuntimeRaw as Record<string, unknown>
    : null;
  const relayRuntimeEnabled = relayRuntime?.enabled === true;
  const ssh = parseSystemTaskSshConfig(value.ssh);
  const sshRecord = value.ssh && typeof value.ssh === 'object' && !Array.isArray(value.ssh)
    ? (value.ssh as Record<string, unknown>)
    : null;
  const identityPrivateKey = sshRecord && typeof sshRecord.identityPrivateKey === 'string'
    ? sshRecord.identityPrivateKey.trim()
    : '';
  if (Object.prototype.hasOwnProperty.call(value, 'expectedHomeServerIdentityId')) {
    throw new SystemTaskExecutionError(
      'invalid_params',
      'expectedHomeServerIdentityId is not a supported remote bootstrap target; use homeTarget.',
    );
  }

  return {
    ssh,
    ...(identityPrivateKey ? { identityPrivateKey } : {}),
    relay: {
      relayUrl: ensureNonEmptyString(relayRecord.relayUrl, 'relay.relayUrl'),
      ...(typeof relayRecord.webappUrl === 'string' ? { webappUrl: relayRecord.webappUrl } : {}),
      ...(typeof relayRecord.publicRelayUrl === 'string' ? { publicRelayUrl: relayRecord.publicRelayUrl } : {}),
    },
    ...(value.homeTarget !== undefined ? { homeTarget: parseResolvedHomeTarget(value.homeTarget) } : {}),
    ...(value.managedEnrollment !== undefined ? { managedEnrollment: ManagedEnrollmentCorrelationV1Schema.parse(value.managedEnrollment) } : {}),
    ...(value.machineDisplayName !== undefined ? { machineDisplayName: MachinePublishedMetadataV1Schema.shape.displayName.parse(value.machineDisplayName) } : {}),
    ...(value.enrollmentIdentity !== undefined ? { enrollmentIdentity: ManagedMachineEnrollmentIdentityV1Schema.parse(value.enrollmentIdentity) } : {}),
    requireLocalApproval: value.requireLocalApproval === true,
    channel: normalizePublicReleaseRingLabel(value.channel) || 'stable',
    serviceMode: value.serviceMode === 'none' ? 'none' : 'user',
    knownHostsMode: value.knownHostsMode === 'system' ? 'system' : 'app',
    ...(relayRuntime
      ? {
          relayRuntime: {
            enabled: relayRuntimeEnabled,
            mode: relayRuntime.mode === 'system' ? 'system' : 'user',
            switchRelayUrl: relayRuntimeEnabled
              ? (relayRuntime.switchRelayUrl === false ? false : true)
              : false,
            ...(relayRuntime.env && typeof relayRuntime.env === 'object' && !Array.isArray(relayRuntime.env)
              ? {
                  env: Object.fromEntries(
                    Object.entries(relayRuntime.env as Record<string, unknown>).map(([key, innerValue]) => [key, String(innerValue ?? '')]),
                  ),
                }
              : {}),
            ...(typeof relayRuntime.selfHostRelayBinaryOverride === 'string'
              ? { selfHostRelayBinaryOverride: relayRuntime.selfHostRelayBinaryOverride }
              : {}),
          },
        }
      : {}),
    ...(value.promptResolution && typeof value.promptResolution === 'object' && !Array.isArray(value.promptResolution)
      ? {
          promptResolution: parseRemoteBootstrapPromptResolution(value.promptResolution as Record<string, unknown>),
        }
      : {}),
  };
}

export function redactRemoteBootstrapPayload(params: Record<string, unknown>): SystemTaskJsonObject {
  return redactSensitiveSystemTaskJsonValue(params) as SystemTaskJsonObject;
}

function normalizeRemoteSshAuth(ssh: SystemTaskSshConnectionConfig): RemoteSshAuth {
  if (ssh.auth === 'keyfile') return { mode: 'keyFile', privateKeyPath: '' };
  if (ssh.auth === 'password') return { mode: 'password', password: '' };
  return { mode: 'agent' };
}

async function resolveRemoteSshAuth(params: Readonly<{
  ctx: Pick<Parameters<InteractiveSystemTaskKind['run']>[0], 'prompt'>;
  parsedRemote: RemoteBootstrapMachineParams;
  materializeIdentityPrivateKey?: RemoteSshBootstrapMachineDeps['materializeIdentityPrivateKey'];
}>): Promise<Readonly<{ auth: RemoteSshAuth; cleanup: (() => Promise<void>) | null }>> {
  const auth = normalizeRemoteSshAuth(params.parsedRemote.ssh);

  if (auth.mode === 'password') {
    const passwordFromParams = typeof params.parsedRemote.ssh.password === 'string'
      ? params.parsedRemote.ssh.password.trim()
      : '';
    if (passwordFromParams) {
      return {
        auth: { mode: 'password', password: passwordFromParams },
        cleanup: null,
      };
    }

    const answer = await params.ctx.prompt({
      kind: 'ssh.password',
      stepId: 'ssh.password',
      message: `Enter the SSH password for ${params.parsedRemote.ssh.target}`,
      data: {
        target: params.parsedRemote.ssh.target,
      },
    }) as Readonly<{ password?: string }> | null;
    const password = typeof answer?.password === 'string' ? answer.password : '';
    if (!password) {
      throw new SystemTaskExecutionError('password_required', 'SSH password auth requires a password.');
    }
    return {
      auth: { mode: 'password', password },
      cleanup: null,
    };
  }

  if (auth.mode === 'keyFile') {
    const identityFile = typeof params.parsedRemote.ssh.identityFile === 'string'
      ? params.parsedRemote.ssh.identityFile.trim()
      : '';
    if (identityFile) {
      return {
        auth: { mode: 'keyFile', privateKeyPath: identityFile },
        cleanup: null,
      };
    }

    const privateKeyMaterial = typeof params.parsedRemote.identityPrivateKey === 'string'
      ? params.parsedRemote.identityPrivateKey.trim()
      : '';
    if (!privateKeyMaterial) {
      throw new SystemTaskExecutionError('invalid_params', 'Missing ssh.identityFile for keyfile auth.');
    }

    if (!params.materializeIdentityPrivateKey) {
      throw new SystemTaskExecutionError('invalid_params', 'SSH private key materialization is unavailable for this transport.');
    }
    const materialized = await params.materializeIdentityPrivateKey({
      privateKey: privateKeyMaterial,
      prefix: 'happier-ssh-bootstrap-',
    });
    return {
      auth: { mode: 'keyFile', privateKeyPath: materialized.identityFilePath },
      cleanup: materialized.cleanup,
    };
  }

  return { auth: { mode: 'agent' }, cleanup: null };
}

function parseRemoteBootstrapPromptResolution(
  value: Record<string, unknown>,
): NonNullable<RemoteBootstrapMachineParams['promptResolution']> {
  const hostTrustRaw = value.hostTrust;
  const hostTrust = hostTrustRaw && typeof hostTrustRaw === 'object' && !Array.isArray(hostTrustRaw)
    ? hostTrustRaw as Record<string, unknown>
    : null;

  return {
    ...(hostTrust
      ? {
          hostTrust: {
            kind: parseRemoteHostTrustPromptKind(hostTrust.kind),
            fingerprint: ensureNonEmptyString(hostTrust.fingerprint, 'promptResolution.hostTrust.fingerprint'),
            ...(hostTrust.existingFingerprint === null
              ? { existingFingerprint: null }
              : (typeof hostTrust.existingFingerprint === 'string'
                  ? { existingFingerprint: hostTrust.existingFingerprint }
                  : {})),
          } as const,
        }
      : {}),
    ...(value.authApproval && typeof value.authApproval === 'object' && !Array.isArray(value.authApproval)
      ? {
          authApproval: {
            publicKey: ensureNonEmptyString(
              (value.authApproval as Record<string, unknown>).publicKey,
              'promptResolution.authApproval.publicKey',
            ),
          } as const,
        }
      : {}),
  };
}

function shouldAutoAcceptHostTrust(
  parsed: RemoteBootstrapMachineParams,
  trust: Extract<RemoteHostTrustResolution, { status: 'prompt' }>,
): boolean {
  const resolution = parsed.promptResolution?.hostTrust;
  if (!resolution) {
    return false;
  }
  if (trust.promptKind !== resolution.kind) {
    return false;
  }

  const promptFingerprint = typeof trust.promptData.fingerprint === 'string'
    ? trust.promptData.fingerprint.trim()
    : '';
  if (!promptFingerprint || promptFingerprint !== resolution.fingerprint.trim()) {
    return false;
  }

  if (trust.promptKind === 'ssh.replaceHostKey') {
    const promptExistingFingerprint = typeof trust.promptData.existingFingerprint === 'string'
      ? trust.promptData.existingFingerprint.trim()
      : null;
    const resolvedExistingFingerprint = resolution.existingFingerprint?.trim() ?? null;
    return promptExistingFingerprint === resolvedExistingFingerprint;
  }

  return true;
}

function normalizeRemoteHostTrustResolution(
  trust: Extract<RemoteHostTrustResolution, { status: 'prompt' }>,
): Extract<RemoteHostTrustResolution, { status: 'prompt' }> {
  return {
    ...trust,
    promptKind: normalizeRemoteHostTrustPromptKind(trust.promptKind),
  };
}

function normalizeRemoteHostTrustPromptKind(value: RemoteHostTrustPromptKind): CanonicalRemoteHostTrustPromptKind {
  if (value === 'sshHostTrust') {
    return 'ssh.trustHost';
  }
  if (value === 'ssh.trustHost' || value === 'ssh.replaceHostKey') {
    return value;
  }
  throw new SystemTaskExecutionError('invalid_params', 'Unsupported SSH host trust prompt kind.');
}

function parseRemoteHostTrustPromptKind(value: unknown): 'ssh.trustHost' | 'ssh.replaceHostKey' {
  if (value === 'ssh.trustHost' || value === 'ssh.replaceHostKey') {
    return value;
  }
  throw new SystemTaskExecutionError('invalid_params', 'Unsupported promptResolution.hostTrust.kind.');
}

function shouldAutoApproveAuthRequest(
  parsed: RemoteBootstrapMachineConfiguration,
  authRequest: Record<string, unknown>,
): boolean {
  const resolvedPublicKey = parsed.promptResolution?.authApproval?.publicKey?.trim();
  const requestedPublicKey = typeof authRequest.publicKey === 'string' ? authRequest.publicKey.trim() : '';
  return Boolean(resolvedPublicKey && requestedPublicKey && resolvedPublicKey === requestedPublicKey);
}

function requireOk(result: RemoteCommandResult, label: string): Record<string, unknown> {
  if (!result.ok) {
    throw new SystemTaskExecutionError('remote_command_failed', `Remote bootstrap step failed: ${label}`);
  }
  return result.data;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}


type RemoteBootstrapMachineConfiguration = Omit<RemoteBootstrapMachineParams, 'ssh' | 'identityPrivateKey'>;
type RemoteMachineBootstrapRecipeParams = Readonly<{
  ctx: InteractiveSystemTaskContext;
  parsedRemote: RemoteBootstrapMachineConfiguration;
  parsedLocalForApproval: RemoteBootstrapMachineConfiguration;
  relayRuntime?: Readonly<{ relayUrl: string; mode: 'user' | 'system' }>;
  relayRuntimeLocalServerUrl?: string;
  remoteHappierExecutor: RemoteSshBootstrapHappierJsonExecutor;
  serviceFlowExecutor: EnrollMachineFlowExecutor;
  createRemoteEnrollmentExecutor(): HappierJsonExecutor | undefined;
  approveLocalAuthRequest(request: Omit<Parameters<RemoteSshBootstrapMachineDeps['approveLocalAuthRequest']>[0], 'parsed'> & { parsed: RemoteBootstrapMachineConfiguration }): Promise<void>;
  deliverAuthApproval?: RemoteSshBootstrapMachineDeps['deliverAuthApproval'];
  reviewedChild?: HostReviewedChildPortV1;
  assertCurrent?: () => Promise<void>;
  enrollmentProcessIO?: 'streaming' | 'buffered';
  onEnrollmentDeadline?: (deadlineMs: number) => void;
  /** Native persistent guests configure their existing process boot owner. */
  startDaemonProcess?: (options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>) => Promise<void>;
}>;

async function runRemoteMachineBootstrapRecipe({
  ctx, parsedRemote, parsedLocalForApproval, relayRuntime, relayRuntimeLocalServerUrl,
  remoteHappierExecutor, serviceFlowExecutor, createRemoteEnrollmentExecutor, approveLocalAuthRequest, deliverAuthApproval, reviewedChild, assertCurrent, enrollmentProcessIO, onEnrollmentDeadline, startDaemonProcess,
}: RemoteMachineBootstrapRecipeParams) {
  // The host-issued Create or Retry admission covers its managed pairing.
  // A correlation, a projected parent or a public task option cannot grant it.
  const reviewedActionId = readHostAdmittedReviewedParentV1(reviewedChild)?.actionId;
  const requireLocalApproval = !parsedRemote.managedEnrollment
    || (reviewedActionId !== 'machines.managed.acquire' && reviewedActionId !== 'machines.managed.bootstrap.retry');
  let deadlineMs: number | undefined;
  const updateEnrollmentDeadline = (nextDeadlineMs: number): void => {
    if (deadlineMs === nextDeadlineMs) return;
    deadlineMs = nextDeadlineMs;
    onEnrollmentDeadline?.(nextDeadlineMs);
  };
  const remainingEnrollmentMs = () => {
    ctx.signal?.throwIfAborted();
    if (deadlineMs === undefined) return undefined;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new SystemTaskExecutionError('auth_request_expired',
      'Remote machine pairing approval expired. Retry setup to request fresh approval.');
    return remaining;
  };
  const webappUrl = deriveWebappUrl(parsedRemote.relay.relayUrl, parsedRemote.relay.webappUrl);
  const relayProfile = {
    serverUrl: parsedRemote.relay.relayUrl, webappUrl,
    localServerUrl: relayRuntimeLocalServerUrl ?? null,
  };
      let enrolledRemoteProfileId: string | null = null;
      const flowExecutor: EnrollMachineFlowExecutor = {
        ...serviceFlowExecutor,
        readAuthStatus: async () => {
          ctx.signal?.throwIfAborted();
          return await serviceFlowExecutor.readAuthStatus();
        },
        ...(serviceFlowExecutor.installDaemonService ? { installDaemonService: async (options) => {
          ctx.signal?.throwIfAborted();
          await serviceFlowExecutor.installDaemonService!({ ...options, timeoutMs: remainingEnrollmentMs() });
        } } : {}),
        ...(serviceFlowExecutor.startDaemonService ? { startDaemonService: async (options) => {
          ctx.signal?.throwIfAborted();
          await serviceFlowExecutor.startDaemonService!({ ...options, timeoutMs: remainingEnrollmentMs() });
        } } : {}),
        ...(serviceFlowExecutor.restartDaemonService ? { restartDaemonService: async () => {
          ctx.signal?.throwIfAborted();
          await serviceFlowExecutor.restartDaemonService!({ timeoutMs: remainingEnrollmentMs() });
        } } : {}),
        ...(serviceFlowExecutor.waitForReadyDaemon ? { waitForReadyDaemon: async (options) => {
          ctx.signal?.throwIfAborted();
          // A live local PID cannot receive the creation-policy child until
          // Home admits its socket and acknowledges machine-control RPCs.
          return await serviceFlowExecutor.waitForReadyDaemon!({ ...options,
            timeoutMs: remainingEnrollmentMs(), requireMachineControlReady: parsedRemote.managedEnrollment !== undefined });
        } } : {}),
        configureRelay: async (profile) => {
          ctx.signal?.throwIfAborted();
          const configuredProfileId = await serviceFlowExecutor.configureRelay(profile);
          if (typeof configuredProfileId === 'string' && configuredProfileId.trim()) {
            enrolledRemoteProfileId = configuredProfileId.trim();
          }
          return configuredProfileId;
        },
        enrollAuthPairing: async ({ approvePairingRequest }) => {
          ctx.signal?.throwIfAborted();
          const enrollmentExecutor = createRemoteEnrollmentExecutor();
          if (!enrollmentExecutor) {
            throw new SystemTaskExecutionError(
              'remote_cli_update_required',
              'Remote Home enrollment requires the canonical CLI executor.',
            );
          }
          let publicKey: string | null = null;
          const result = await runRemoteHomeEnrollmentFlow({
            executor: enrollmentExecutor,
            processIO: enrollmentProcessIO,
            homeTargetInput: parsedRemote.homeTarget
              ? createTransferableHomeTargetInput(parsedRemote.homeTarget)
              : { kind: 'https_url', url: parsedRemote.relay.relayUrl },
            signal: ctx.signal,
            onEnrollmentDeadline: updateEnrollmentDeadline,
            ...(parsedRemote.managedEnrollment ? { managedEnrollment: parsedRemote.managedEnrollment, machineDisplayName: parsedRemote.machineDisplayName } : {}),
            approvePairingRequest: async (request) => {
              publicKey = request.publicKey;
              if (!approvePairingRequest) {
                throw new SystemTaskExecutionError('approval_required', 'Pairing approval is required.');
              }
              await approvePairingRequest({
                publicKey: request.publicKey,
                requestPayload: request,
              });
            },
          });
          enrolledRemoteProfileId = result.remoteProfileId;
          return { publicKey, machineId: result.machineId };
        },
      };

      // The admitted identity owns its daemon lifecycle, independent of the
      // native/SSH carrier. Personal enrollment retains its explicit choice.
      const lifecycle = parsedRemote.enrollmentIdentity?.kind === 'dedicatedDaemonUser' ? 'service'
        : parsedRemote.enrollmentIdentity?.kind === 'guestProcess' || startDaemonProcess ? 'process'
          : (parsedRemote.serviceMode ?? 'user') === 'none' ? 'none' : 'service';
      const processManaged = lifecycle === 'process';
      const shouldManageService = lifecycle === 'service';
      if (shouldManageService && await preflightRemoteBackgroundServiceReplacement({
        ctx,
        listServices: async () => requireOk(
          await (async () => {
            ctx.signal?.throwIfAborted();
            return await remoteHappierExecutor.runHappierJson({ args: ['service', 'list', '--json'] });
          })(),
          'daemon.service.list',
        ),
        targetReleaseChannel: parsedRemote.channel ?? 'stable',
        targetServerUrl: relayProfile.serverUrl,
        mode: 'user',
        stepId: 'daemon.service.preflight',
      })) {
        // The remote CLI has no per-service uninstall; replacement removes every
        // remote daemon service, exactly as the canonical setup owner does.
        ctx.signal?.throwIfAborted();
        requireOk(
          await remoteHappierExecutor.runHappierJson({ args: ['service', 'uninstall', '--all', '--yes', '--json'] }),
          'daemon.service.uninstallAll',
        );
      }

      ctx.signal?.throwIfAborted();
      const flowResult = await runEnrollMachineFlow({
        relayProfile,
        executor: flowExecutor,
        ...(parsedRemote.homeTarget?.descriptor
          ? {
              initialAuthStatus: {
                authenticated: false,
                credentialState: 'missing' as const,
                machineRegistrationState: 'no-local-id' as const,
                machineId: null,
              },
            }
          : {}),
        steps: {
          configureRelay: !parsedRemote.homeTarget?.descriptor,
          installService: shouldManageService,
          startService: shouldManageService,
          verifyService: shouldManageService,
        },
        stepIds: {
          authRequest: 'ssh.auth.request',
          authWait: 'ssh.auth.wait',
        },
        signal: ctx.signal,
        emit: (event) => {
          ctx.emit({
            type: 'progress',
            stepId: event.stepId,
            ...(event.message ? { message: event.message } : {}),
          });
        },
        approvePairingRequest: async ({ publicKey, requestPayload }) => {
          const homeServerIdentityId = typeof requestPayload.homeServerIdentityId === 'string'
            ? requestPayload.homeServerIdentityId.trim()
            : '';
          if (!homeServerIdentityId) {
            throw new SystemTaskExecutionError(
              'remote_cli_update_required',
              'The remote Happier CLI does not provide authenticated v3 Home identity context.',
            );
          }
          if (parsedRemote.homeTarget) {
            try {
              assertResolvedHomeTargetIdentity(parsedRemote.homeTarget, homeServerIdentityId);
            } catch {
              throw new SystemTaskExecutionError(
                'home_identity_mismatch',
                'Remote Home identity does not match the selected Home.',
              );
            }
          }
          const approvalPayload = redactRemoteBootstrapPayload(requestPayload);
          if (deliverAuthApproval || requireLocalApproval && !shouldAutoApproveAuthRequest(parsedRemote, approvalPayload)) {
            const approval = await ctx.prompt({
              kind: 'auth.approveRemoteProvisioning',
              stepId: 'ssh.auth.approval',
              message: parsedRemote.managedEnrollment
                ? 'Sign this managed machine into your Account for Account-wide automation?'
                : 'Approve remote machine pairing',
              data: parsedRemote.managedEnrollment ? { ...approvalPayload, credentialScope: 'account', credentialAuthority: 'account_automation' } : approvalPayload,
              ...(deliverAuthApproval ? { deliver: async (request: unknown) => {
                // Releasing pairing context lets the requester approve while
                // the streaming guest is already waiting to claim/register.
                await assertCurrent?.();
                remainingEnrollmentMs();
                return await deliverAuthApproval({ request, publicKey, homeServerIdentityId,
                  pairing: requestPayload.pairing, supportsTokenOnly: requestPayload.supportsTokenOnly === true, signal: ctx.signal });
              } } : {}),
            }) as { approved?: boolean };
            if (approval?.approved !== true) {
              throw new SystemTaskExecutionError('approval_declined', 'Remote machine pairing was not approved');
            }
          }

          ctx.signal?.throwIfAborted();
          // The requesting client has submitted the ordinary Home approval.
          // Guest claim/registration verifies it; never fall back to local credentials.
          if (deliverAuthApproval) return;
          await assertCurrent?.();
          try {
            await approveLocalAuthRequest({
              publicKey,
              homeServerIdentityId,
              parsed: parsedLocalForApproval,
              ...(requestPayload.pairing !== undefined && requestPayload.pairing !== null
                ? { pairing: requestPayload.pairing }
                : {}),
              ...(requestPayload.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
              signal: ctx.signal,
            });
          } catch (error) {
            if (
              (parsedRemote.requireLocalApproval === true || Boolean(parsedRemote.homeTarget))
              && shouldIgnoreLocalApprovalError(error)
            ) {
              throw new SystemTaskExecutionError(
                'local_approval_required',
                'Remote setup requires local approval, but this CLI is not authenticated.',
              );
            }
            if (!shouldIgnoreLocalApprovalError(error)) {
              throw error;
            }
          }
        },
      });

      let daemonStatus = flowResult.daemonStatus;
      if (processManaged) {
        const executor = createRemoteEnrollmentExecutor();
        if (!executor) throw new SystemTaskExecutionError('remote_cli_update_required', 'Remote enrollment requires the canonical CLI executor.');
        const options = { signal: ctx.signal, timeoutMs: remainingEnrollmentMs() };
        if (startDaemonProcess) await startDaemonProcess(options);
        else await executor.runHappierJson(['daemon', 'start', '--json'], options);
        daemonStatus = await createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor }).waitForReadyDaemon!({
          signal: ctx.signal, timeoutMs: remainingEnrollmentMs(), requireServiceInstalled: false,
          requireMachineControlReady: parsedRemote.managedEnrollment !== undefined,
        });
        if (!daemonStatus.daemonRunning || daemonStatus.needsAuth) throw new SystemTaskExecutionError(
          'daemon_service_not_ready', 'The enrolled daemon did not reach a ready state.');
      }

      if (parsedRemote.homeTarget) {
        const confirmed = resolveEnrollMachineReadiness(await flowExecutor.readAuthStatus());
        if (
          confirmed.credentialState !== 'valid'
          || confirmed.machineRegistrationState !== 'server-confirmed'
          || !confirmed.machineId
        ) {
          throw new SystemTaskExecutionError(
            'machine_registration_unconfirmed',
            'The selected Home did not confirm the remote machine registration.',
          );
        }
        if (flowResult.machineId && flowResult.machineId !== confirmed.machineId) {
          throw new SystemTaskExecutionError(
            'machine_identity_mismatch',
            'The selected Home confirmed a different remote machine identity.',
          );
        }
        if (
          (shouldManageService || processManaged)
          && enrolledRemoteProfileId
          && daemonStatus?.activeServerId !== enrolledRemoteProfileId
        ) {
          throw new SystemTaskExecutionError(
            'daemon_home_mismatch',
            'The background service is not connected through the enrolled Home profile.',
          );
        }
      }

      ctx.signal?.throwIfAborted();
      ctx.emit({
        type: 'progress',
        stepId: 'ssh.complete',
        message: 'Remote bootstrap finished',
      });

        return {
          ...(flowResult.publicKey ? { publicKey: flowResult.publicKey } : {}),
          machineId: flowResult.machineId,
          ...(relayRuntime ? { relayRuntime } : {}),
        };
}

/** Native IO joins the same installer/enrollment/service flow as SSH. */
export function createRemoteNativeBootstrapMachineTaskKind(input: Readonly<{
  onEnrollmentDeadline?: (deadlineMs: number) => void;
  startDaemonProcess?: RemoteMachineBootstrapRecipeParams['startDaemonProcess'];
  configuration: RemoteBootstrapMachineConfiguration;
  installRemoteCli(signal?: AbortSignal, context?: Pick<InteractiveSystemTaskContext, 'taskId' | 'emit' | 'prompt'>): Promise<void>;
  executor: HappierJsonExecutor;
  approveLocalAuthRequest: RemoteMachineBootstrapRecipeParams['approveLocalAuthRequest'];
  reviewedChild?: HostReviewedChildPortV1;
  deliverAuthApproval?: RemoteSshBootstrapMachineDeps['deliverAuthApproval'];
  /** Pairing authority boundary only; installation uses the task's abort signal. */
  assertCurrent(): Promise<void>;
}>): InteractiveSystemTaskKind<Readonly<{ publicKey?: string; machineId: string | null }>> {
  return {
    async run(ctx) {
      ctx.signal?.throwIfAborted();
      ctx.emit({ type: 'progress', stepId: 'ssh.installCli', message: 'Ensuring Happier is installed on the remote machine' });
      await input.installRemoteCli(ctx.signal, ctx);
      ctx.signal?.throwIfAborted();
      const executor: HappierJsonExecutor = {
        runHappierText: async (args, options) => {
          ctx.signal?.throwIfAborted();
          return await input.executor.runHappierText(args, { ...options, signal: options?.signal ?? ctx.signal });
        },
        runHappierJson: async (args, options) => {
          ctx.signal?.throwIfAborted();
          return await input.executor.runHappierJson(args, { ...options, signal: options?.signal ?? ctx.signal });
        },
      };
      return await runRemoteMachineBootstrapRecipe({
        ctx, parsedRemote: input.configuration, parsedLocalForApproval: input.configuration,
        remoteHappierExecutor: { runHappierJson: async ({ args }) => {
          const result = await executor.runHappierJson(args);
          return normalizeRemoteBootstrapCliJsonResult(result, args[0] === 'auth' && args[1] === 'status');
        } },
        serviceFlowExecutor: createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor }),
        createRemoteEnrollmentExecutor: () => executor,
        approveLocalAuthRequest: input.approveLocalAuthRequest,
        deliverAuthApproval: input.deliverAuthApproval,
        reviewedChild: input.reviewedChild,
        assertCurrent: input.assertCurrent,
        enrollmentProcessIO: 'buffered',
        onEnrollmentDeadline: input.onEnrollmentDeadline,
        startDaemonProcess: input.startDaemonProcess,
      });
    },
  };
}
