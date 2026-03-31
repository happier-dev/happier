import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { redactSensitiveSystemTaskJsonValue, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import {
  parseSystemTaskSshConfig,
  type RelayRuntimeTaskParams,
  type SystemTaskSshConnectionConfig,
} from './relayRuntimeKinds.js';

type RemoteCommandResult = Readonly<{
  ok: boolean;
  data: Record<string, unknown>;
}>;

type CanonicalRemoteHostTrustPromptKind = 'ssh.trustHost' | 'ssh.replaceHostKey';
type RemoteHostTrustPromptKind = CanonicalRemoteHostTrustPromptKind | 'sshHostTrust';

type RemoteSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = String(hostname ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (normalized === '127.0.0.1') return true;
  if (normalized === '0.0.0.0') return true;
  if (normalized === '::1') return true;
  return false;
}

function isLoopbackRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLoopbackHostname(parsed.hostname);
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

export interface RemoteBootstrapMachineParams {
  ssh: SystemTaskSshConnectionConfig;
  relay: Readonly<{
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
  }>;
  channel?: 'stable' | 'preview' | 'dev';
  serviceMode?: 'user' | 'none';
  knownHostsMode?: 'app' | 'system';
  relayRuntime?: Readonly<{
    enabled: boolean;
    mode?: 'user' | 'system';
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
  runRemoteCommand: (params: Readonly<{
    label:
      | 'auth.status'
      | 'server.configure'
      | 'auth.request'
      | 'auth.wait'
      | 'daemon.service.install'
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
      const parsedRaw = parseRemoteBootstrapMachineParams(ctx.params);
      const publicRelayUrl = typeof parsedRaw.relay.publicRelayUrl === 'string'
        ? parsedRaw.relay.publicRelayUrl.trim()
        : '';
      const remoteRelayUrl = publicRelayUrl || parsedRaw.relay.relayUrl;
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

      if (isLoopbackRelayUrl(parsedRemote.relay.relayUrl)) {
        throw new SystemTaskExecutionError(
          'relay_url_unreachable',
          'Remote setup cannot use a loopback Relay URL. Provide relay.publicRelayUrl.',
        );
      }
      const knownHostsMode = parsedRemote.knownHostsMode ?? 'app';
      const auth = await resolveRemoteSshAuth({
        ctx,
        parsedRemote,
      });

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
        relayRuntimeLocalServerUrl = relayRuntime.relayUrl;
      }

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.installCli',
        message: 'Ensuring Happier is installed on the remote machine',
      });

      try {
        requireOk(
          await deps.runRemoteCommand({
            label: 'server.configure',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            ...(relayRuntimeLocalServerUrl ? { data: { localServerUrl: relayRuntimeLocalServerUrl } } : {}),
          }),
          'server.configure',
        );
      } catch {
        await deps.installRemoteCli({
          parsed: parsedRemote,
          auth,
          knownHostsMode,
        });
        requireOk(
          await deps.runRemoteCommand({
            label: 'server.configure',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            ...(relayRuntimeLocalServerUrl ? { data: { localServerUrl: relayRuntimeLocalServerUrl } } : {}),
          }),
          'server.configure',
        );
      }

      const authStatus = requireOk(
        await deps.runRemoteCommand({
          label: 'auth.status',
          parsed: parsedRemote,
          auth,
          knownHostsMode,
        }),
        'auth.status',
      );

      const statusMachineId = typeof authStatus.machineId === 'string' ? authStatus.machineId : null;
      let publicKey: string | null = null;
      let machineId: string | null = statusMachineId;

      if (authStatus.authenticated !== true) {
        ctx.emit({
          type: 'progress',
          stepId: 'ssh.auth.request',
          message: 'Requesting remote machine pairing',
        });

        const authRequest = requireOk(
          await deps.runRemoteCommand({
            label: 'auth.request',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            ...(relayRuntimeLocalServerUrl ? { data: { localServerUrl: relayRuntimeLocalServerUrl } } : {}),
          }),
          'auth.request',
        );

        const approvalPayload = redactRemoteBootstrapPayload(authRequest);
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

        publicKey = ensureNonEmptyString(authRequest.publicKey, 'auth.request.publicKey');
        await deps.approveLocalAuthRequest({
          publicKey,
          parsed: parsedLocalForApproval,
        });

        ctx.emit({
          type: 'progress',
          stepId: 'ssh.auth.wait',
          message: 'Waiting for remote machine pairing confirmation',
        });

        const authWait = requireOk(
          await deps.runRemoteCommand({
            label: 'auth.wait',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            data: relayRuntimeLocalServerUrl
              ? { publicKey, localServerUrl: relayRuntimeLocalServerUrl }
              : { publicKey },
          }),
          'auth.wait',
        );

        machineId = typeof authWait.machineId === 'string' ? authWait.machineId : statusMachineId;
      }

      if ((parsedRemote.serviceMode ?? 'user') !== 'none') {
        requireOk(
          await deps.runRemoteCommand({
            label: 'daemon.service.install',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            ...(relayRuntimeLocalServerUrl ? { data: { localServerUrl: relayRuntimeLocalServerUrl } } : {}),
          }),
          'daemon.service.install',
        );
        requireOk(
          await deps.runRemoteCommand({
            label: 'daemon.service.start',
            parsed: parsedRemote,
            auth,
            knownHostsMode,
            ...(relayRuntimeLocalServerUrl ? { data: { localServerUrl: relayRuntimeLocalServerUrl } } : {}),
          }),
          'daemon.service.start',
        );
      }

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.complete',
        message: 'Remote bootstrap finished',
      });

      return {
        ...(publicKey ? { publicKey } : {}),
        machineId,
        ...(relayRuntime ? { relayRuntime } : {}),
      };
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

  return {
    ssh: parseSystemTaskSshConfig(value.ssh),
    relay: {
      relayUrl: ensureNonEmptyString(relayRecord.relayUrl, 'relay.relayUrl'),
      ...(typeof relayRecord.webappUrl === 'string' ? { webappUrl: relayRecord.webappUrl } : {}),
      ...(typeof relayRecord.publicRelayUrl === 'string' ? { publicRelayUrl: relayRecord.publicRelayUrl } : {}),
    },
    channel: value.channel === 'preview' || value.channel === 'dev' ? value.channel : 'stable',
    serviceMode: value.serviceMode === 'none' ? 'none' : 'user',
    knownHostsMode: value.knownHostsMode === 'system' ? 'system' : 'app',
    ...(relayRuntime
      ? {
          relayRuntime: {
            enabled: relayRuntime.enabled === true,
            mode: relayRuntime.mode === 'system' ? 'system' : 'user',
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
  if (ssh.auth === 'keyfile') {
    return {
      mode: 'keyFile',
      privateKeyPath: ensureNonEmptyString(ssh.identityFile, 'ssh.identityFile'),
    };
  }
  if (ssh.auth === 'password') {
    return {
      mode: 'password',
      password: '',
    };
  }
  return { mode: 'agent' };
}

async function resolveRemoteSshAuth(params: Readonly<{
  ctx: Pick<Parameters<InteractiveSystemTaskKind['run']>[0], 'prompt'>;
  parsedRemote: RemoteBootstrapMachineParams;
}>): Promise<RemoteSshAuth> {
  const auth = normalizeRemoteSshAuth(params.parsedRemote.ssh);
  if (auth.mode !== 'password') {
    return auth;
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
    mode: 'password',
    password,
  };
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
