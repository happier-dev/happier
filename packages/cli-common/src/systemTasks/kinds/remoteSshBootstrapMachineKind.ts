import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';
import {
  isLoopbackHostname,
  normalizeHostnameForLoopbackCheck,
} from '@happier-dev/protocol';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { redactSensitiveSystemTaskJsonValue, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { runSetupMachineRecipe, type SetupMachineRecipeExecutor } from '../recipes/setupMachineRecipe.js';
import {
  createRemoteSetupMachineRecipeHappierExecutor,
  createSetupMachineRecipeExecutorFromRemoteCommandRunner,
} from '../executors/remoteSetupMachineRecipeExecutor.js';
import {
  parseSystemTaskSshConfig,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from './relayRuntimeKinds.js';

type RemoteCommandResult = Readonly<{
  ok: boolean;
  data: Record<string, unknown>;
}>;

type RemoteBootstrapExistingDaemonServiceSummary = Readonly<{
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

function summarizeDiscoveredRemoteDaemonServices(data: Record<string, unknown>): RemoteBootstrapExistingDaemonServiceSummary[] {
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
    const releaseChannel =
      record.ring === 'stable' || record.ring === 'preview' || record.ring === 'dev'
        ? record.ring
        : null;
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

function shouldPromptForRemoteDaemonServiceReplacement(
  params: Readonly<{
    services: readonly RemoteBootstrapExistingDaemonServiceSummary[];
    targetReleaseChannel: 'stable' | 'preview' | 'dev';
  }>,
): boolean {
  if (params.services.length === 0) {
    return false;
  }
  if (params.services.length > 1) {
    return true;
  }
  const [existing] = params.services;
  return existing?.releaseChannel !== params.targetReleaseChannel;
}

export interface RemoteBootstrapMachineParams {
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string;
  relay: Readonly<{
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
  }>;
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
  resolveHostTrust: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
  }>) => Promise<RemoteHostTrustResolution>;
  installRemoteCli: (params: Readonly<{
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
  }>) => Promise<void>;
  approveLocalAuthRequest: (params: Readonly<{
    publicKey: string;
    parsed: RemoteBootstrapMachineParams;
  }>) => Promise<void>;
  createHappierJsonExecutor?: (params: Readonly<{
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    localServerUrl?: string;
  }>) => RemoteSshBootstrapHappierJsonExecutor;
  runRemoteCommand: (params: Readonly<{
    label:
      | 'auth.status'
      | 'server.configure'
      | 'auth.request'
      | 'auth.wait'
      | 'daemon.service.list'
      | 'daemon.service.install'
      | 'daemon.service.uninstallAll'
      | 'daemon.service.start'
      | 'relay.runtime.install';
    parsed: RemoteBootstrapMachineParams;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    data?: Record<string, unknown>;
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
        if (isLoopbackRelayUrl(parsedRemote.relay.relayUrl) && !relayRuntimeEnabled) {
          throw new SystemTaskExecutionError(
            'relay_url_unreachable',
            'Remote setup cannot use a loopback Relay URL. Provide relay.publicRelayUrl.',
          );
        }
        const knownHostsMode = parsedRemote.knownHostsMode ?? 'app';
        const authResolution = await resolveRemoteSshAuth({
          ctx,
          parsedRemote,
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

        let relayRuntime: Readonly<{ relayUrl: string; mode: 'user' | 'system' }> | undefined;
        let relayRuntimeLocalServerUrl: string | undefined;
        if (parsedRemote.relayRuntime?.enabled === true) {
        ctx.emit({
          type: 'progress',
          stepId: 'relay.runtime.install',
          message: 'Installing relay runtime on the remote machine',
        });

        const relayInstall = requireOk(
          await deps.runRemoteCommand({
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

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.installCli',
        message: 'Ensuring Happier is installed on the remote machine',
      });

      const relayProfile = {
        serverUrl: parsedRemote.relay.relayUrl,
        webappUrl,
        localServerUrl: relayRuntimeLocalServerUrl ?? null,
      } as const;

      const remoteHappierExecutor = createRemoteSetupMachineRecipeHappierExecutor({
        parsed: parsedRemote,
        auth,
        knownHostsMode,
        ...(relayRuntimeLocalServerUrl ? { localServerUrl: relayRuntimeLocalServerUrl } : {}),
        runRemoteCommand: deps.runRemoteCommand,
        ...(deps.createHappierJsonExecutor ? { createHappierJsonExecutor: deps.createHappierJsonExecutor } : {}),
      });

      const recipeExecutor: SetupMachineRecipeExecutor = createSetupMachineRecipeExecutorFromRemoteCommandRunner({
        parsed: parsedRemote,
        auth,
        knownHostsMode,
        ...(relayRuntimeLocalServerUrl ? { localServerUrl: relayRuntimeLocalServerUrl } : {}),
        serviceMode: parsedRemote.serviceMode ?? 'user',
        installRemoteCli: deps.installRemoteCli,
        runRemoteCommand: deps.runRemoteCommand,
        ...(deps.createHappierJsonExecutor ? { createHappierJsonExecutor: deps.createHappierJsonExecutor } : {}),
      });

      let shouldManageService = (parsedRemote.serviceMode ?? 'user') !== 'none';
      if (shouldManageService) {
        let discoveredServices: RemoteBootstrapExistingDaemonServiceSummary[] | null = null;
        try {
          discoveredServices = summarizeDiscoveredRemoteDaemonServices(
            requireOk(
              await remoteHappierExecutor.runHappierJson({ args: ['service', 'list', '--json'] }),
              'daemon.service.list',
            ),
          );
        } catch {
          discoveredServices = null;
        }
        if (discoveredServices) {
          if (shouldPromptForRemoteDaemonServiceReplacement({
            services: discoveredServices,
            targetReleaseChannel: parsedRemote.channel ?? 'stable',
          })) {
            const answer = await ctx.prompt({
              kind: 'daemon.replaceRemoteBackgroundServices',
              stepId: 'daemon.service.preflight',
              message: 'Remote machine already has Happier background services. Replace them with the selected release channel?',
              data: {
                targetServerUrl: relayProfile.serverUrl,
                targetReleaseChannel: parsedRemote.channel ?? 'stable',
                services: discoveredServices,
              },
            }) as { replaceExistingServices?: boolean };
            if (answer.replaceExistingServices === true) {
              requireOk(
                await remoteHappierExecutor.runHappierJson({ args: ['service', 'uninstall', '--all', '--yes', '--json'] }),
                'daemon.service.uninstallAll',
              );
            } else {
              shouldManageService = false;
              ctx.emit({
                type: 'progress',
                stepId: 'daemon.service.preflight',
                message: 'Keeping existing remote background services unchanged',
              });
            }
          }
        }
      }

      const recipeResult = await runSetupMachineRecipe({
        relayProfile,
        executor: recipeExecutor,
        steps: {
          installService: shouldManageService,
          startService: shouldManageService,
          verifyService: false,
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
          const approvalPayload = redactRemoteBootstrapPayload(requestPayload);
          if (!shouldAutoApproveAuthRequest(parsedRemote, approvalPayload)) {
            const approval = await ctx.prompt({
              kind: 'auth.approveRemoteProvisioning',
              stepId: 'ssh.auth.approval',
              message: 'Approve remote machine pairing',
              data: approvalPayload,
            }) as { approved?: boolean };
            if (approval?.approved !== true) {
              throw new SystemTaskExecutionError('approval_declined', 'Remote machine pairing was not approved');
            }
          }

          try {
            await deps.approveLocalAuthRequest({
              publicKey,
              parsed: parsedLocalForApproval,
            });
          } catch (error) {
            if (parsedRemote.requireLocalApproval === true && shouldIgnoreLocalApprovalError(error)) {
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

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.complete',
        message: 'Remote bootstrap finished',
      });

        return {
          ...(recipeResult.publicKey ? { publicKey: recipeResult.publicKey } : {}),
          machineId: recipeResult.machineId,
          ...(relayRuntime ? { relayRuntime } : {}),
        };
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

  return {
    ssh,
    ...(identityPrivateKey ? { identityPrivateKey } : {}),
    relay: {
      relayUrl: ensureNonEmptyString(relayRecord.relayUrl, 'relay.relayUrl'),
      ...(typeof relayRecord.webappUrl === 'string' ? { webappUrl: relayRecord.webappUrl } : {}),
      ...(typeof relayRecord.publicRelayUrl === 'string' ? { publicRelayUrl: relayRecord.publicRelayUrl } : {}),
    },
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

    const { materializeSshIdentityPrivateKeyToTempFile } = await import('../ssh/materializeSshIdentityPrivateKeyToTempFile.js');
    const materialized = await materializeSshIdentityPrivateKeyToTempFile({
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
  parsed: RemoteBootstrapMachineParams,
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
