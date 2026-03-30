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
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>;

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
  publicKey: string;
  machineId: string | null;
  relayRuntime?: Readonly<{
    relayUrl: string;
    mode: 'user' | 'system';
  }>;
}>> {
  return {
    async run(ctx) {
      const parsed = parseRemoteBootstrapMachineParams(ctx.params);
      const knownHostsMode = parsed.knownHostsMode ?? 'app';
      const auth = normalizeRemoteSshAuth(parsed.ssh);

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.trust',
        message: 'Verifying SSH host trust',
      });

      const trustResolution = await deps.resolveHostTrust({
        ssh: parsed.ssh,
        knownHostsMode,
      });
      const trust = trustResolution.status === 'prompt'
        ? normalizeRemoteHostTrustResolution(trustResolution)
        : trustResolution;

      if (trust.status === 'prompt') {
        if (shouldAutoAcceptHostTrust(parsed, trust)) {
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
        message: 'Installing Happier on the remote machine',
      });

      await deps.installRemoteCli({
        parsed,
        auth,
        knownHostsMode,
      });

      const authStatus = requireOk(
        await deps.runRemoteCommand({
          label: 'auth.status',
          parsed,
          auth,
          knownHostsMode,
        }),
        'auth.status',
      );

      if (authStatus.authenticated === true) {
        throw new SystemTaskExecutionError('already_authenticated', 'Remote machine is already authenticated');
      }

      requireOk(
        await deps.runRemoteCommand({
          label: 'server.configure',
          parsed,
          auth,
          knownHostsMode,
        }),
        'server.configure',
      );

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.auth.request',
        message: 'Requesting remote machine pairing',
      });

      const authRequest = requireOk(
        await deps.runRemoteCommand({
          label: 'auth.request',
          parsed,
          auth,
          knownHostsMode,
        }),
        'auth.request',
      );

      const approvalPayload = redactRemoteBootstrapPayload(authRequest);
      if (!shouldAutoApproveAuthRequest(parsed, approvalPayload)) {
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

      const publicKey = ensureNonEmptyString(authRequest.publicKey, 'auth.request.publicKey');
      await deps.approveLocalAuthRequest({
        publicKey,
        parsed,
      });

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.auth.wait',
        message: 'Waiting for remote machine pairing confirmation',
      });

      const authWait = requireOk(
        await deps.runRemoteCommand({
          label: 'auth.wait',
          parsed,
          auth,
          knownHostsMode,
          data: { publicKey },
        }),
        'auth.wait',
      );

      if ((parsed.serviceMode ?? 'user') !== 'none') {
        requireOk(
          await deps.runRemoteCommand({
            label: 'daemon.service.install',
            parsed,
            auth,
            knownHostsMode,
          }),
          'daemon.service.install',
        );
        requireOk(
          await deps.runRemoteCommand({
            label: 'daemon.service.start',
            parsed,
            auth,
            knownHostsMode,
          }),
          'daemon.service.start',
        );
      }

      let relayRuntime: Readonly<{ relayUrl: string; mode: 'user' | 'system' }> | undefined;
      if (parsed.relayRuntime?.enabled === true) {
        ctx.emit({
          type: 'progress',
          stepId: 'relay.runtime.install',
          message: 'Installing relay runtime on the remote machine',
        });

        const relayInstall = requireOk(
          await deps.runRemoteCommand({
            label: 'relay.runtime.install',
            parsed,
            auth,
            knownHostsMode,
          }),
          'relay.runtime.install',
        );

        relayRuntime = {
          relayUrl: typeof relayInstall.relayUrl === 'string' && relayInstall.relayUrl.trim()
            ? relayInstall.relayUrl.trim()
            : typeof relayInstall.serverUrl === 'string' && relayInstall.serverUrl.trim()
              ? relayInstall.serverUrl.trim()
              : parsed.relay.relayUrl,
          mode: parsed.relayRuntime.mode ?? 'user',
        };
      }

      ctx.emit({
        type: 'progress',
        stepId: 'ssh.complete',
        message: 'Remote bootstrap finished',
      });

      return {
        publicKey,
        machineId: typeof authWait.machineId === 'string' ? authWait.machineId : null,
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
  return { mode: 'agent' };
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
