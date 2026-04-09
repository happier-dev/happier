import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { redactSensitiveSystemTaskJsonValue, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { parseSystemTaskSshConfig, type SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';
import type { RemoteHostTrustResolution } from './remoteSshBootstrapMachineKind.js';
import { materializeSshIdentityPrivateKeyToTempFile } from '../ssh/materializeSshIdentityPrivateKeyToTempFile.js';

export type RemoteSshManageHostAction =
  | 'testConnection'
  | 'installOrUpdateCli'
  | 'daemonService.installOrUpdate'
  | 'daemonService.start'
  | 'daemonService.stop'
  | 'daemonService.restart'
  | 'relayRuntime.status'
  | 'relayRuntime.installOrUpdate'
  | 'relayRuntime.start'
  | 'relayRuntime.stop'
  | 'relayRuntime.restart';

type RemoteSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'password'; password: string }>;

export type RemoteSshManageHostDeps = Readonly<{
  resolveHostTrust: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
  }>) => Promise<RemoteHostTrustResolution>;
  testConnection: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
  }>) => Promise<void>;
  installRemoteCli: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    channel: 'stable' | 'preview' | 'dev';
  }>) => Promise<void>;
  runDaemonServiceCommand: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    action: 'installOrUpdate' | 'start' | 'stop' | 'restart';
    serviceMode: 'user' | 'none';
    channel: 'stable' | 'preview' | 'dev';
  }>) => Promise<void>;
  runRelayRuntimeCommand: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    auth: RemoteSshAuth;
    knownHostsMode: 'app' | 'system';
    action: 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>) => Promise<SystemTaskJsonObject | null | void>;
}>;

export function redactRemoteSshManageHostPayload(value: SystemTaskJsonValue): SystemTaskJsonValue {
  return redactSensitiveSystemTaskJsonValue(value);
}

export function createRemoteSshManageHostTaskKind(
  deps: RemoteSshManageHostDeps,
): InteractiveSystemTaskKind<SystemTaskJsonObject> {
  return {
    async run(ctx) {
      const parsed = parseRemoteSshManageHostParams(ctx.params);
      const knownHostsMode = parsed.knownHostsMode;
      let cleanupTempIdentityFile: (() => Promise<void>) | null = null;

      try {
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

        const authResolution = await resolveRemoteSshAuth({
          ctx,
          ssh: parsed.ssh,
          identityPrivateKey: parsed.identityPrivateKey,
        });
        cleanupTempIdentityFile = authResolution.cleanup;
        const auth = authResolution.auth;

        if (parsed.action === 'testConnection') {
          ctx.emit({
            type: 'progress',
            stepId: 'ssh.testConnection',
            message: 'Testing SSH connection',
          });
          await deps.testConnection({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
          });
          return { action: parsed.action };
        }

        if (parsed.action === 'installOrUpdateCli') {
          ctx.emit({
            type: 'progress',
            stepId: 'remote.cli.install',
            message: 'Installing Happier CLI',
          });
          await deps.installRemoteCli({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            channel: parsed.channel,
          });
          return { action: parsed.action };
        }

        const relayRuntimeAction = resolveRelayRuntimeAction(parsed.action);
        if (relayRuntimeAction) {
          ctx.emit({
            type: 'progress',
            stepId: `relay.runtime.${relayRuntimeAction}`,
            message: 'Managing relay runtime',
          });

          const result = await deps.runRelayRuntimeCommand({
            ssh: parsed.ssh,
            auth,
            knownHostsMode,
            action: relayRuntimeAction,
            channel: parsed.relayRuntime?.channel ?? 'stable',
            mode: parsed.relayRuntime?.mode ?? 'user',
          });

          return {
            action: parsed.action,
            ...(result ? { relayRuntime: result } : {}),
          };
        }

        const daemonAction = resolveDaemonServiceAction(parsed.action);
        if (!daemonAction) {
          throw new SystemTaskExecutionError('invalid_params', 'Unsupported remote host action.');
        }

        ctx.emit({
          type: 'progress',
          stepId: 'remote.cli.install',
          message: 'Ensuring Happier CLI is installed',
        });
        await deps.installRemoteCli({
          ssh: parsed.ssh,
          auth,
          knownHostsMode,
          channel: parsed.channel,
        });

        ctx.emit({
          type: 'progress',
          stepId: `daemon.service.${daemonAction}`,
          message: 'Managing background service',
        });
        await deps.runDaemonServiceCommand({
          ssh: parsed.ssh,
          auth,
          knownHostsMode,
          action: daemonAction,
          serviceMode: parsed.serviceMode,
          channel: parsed.channel,
        });

        return { action: parsed.action };
      } finally {
        await cleanupTempIdentityFile?.().catch(() => {});
      }
    },
  };
}

type CanonicalRemoteHostTrustPromptKind = 'ssh.trustHost' | 'ssh.replaceHostKey';
type RemoteHostTrustPromptKind = CanonicalRemoteHostTrustPromptKind | 'sshHostTrust';

function normalizeRemoteHostTrustResolution(
  trust: Extract<RemoteHostTrustResolution, { status: 'prompt' }>,
): Extract<RemoteHostTrustResolution, { status: 'prompt' }> {
  return {
    ...trust,
    promptKind: normalizeRemoteHostTrustPromptKind(trust.promptKind as RemoteHostTrustPromptKind),
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

type DaemonServiceAction = 'installOrUpdate' | 'start' | 'stop' | 'restart';

function resolveDaemonServiceAction(action: RemoteSshManageHostAction): DaemonServiceAction | null {
  if (action === 'daemonService.installOrUpdate') return 'installOrUpdate';
  if (action === 'daemonService.start') return 'start';
  if (action === 'daemonService.stop') return 'stop';
  if (action === 'daemonService.restart') return 'restart';
  return null;
}

type RelayRuntimeAction = 'status' | 'installOrUpdate' | 'start' | 'stop' | 'restart';

function resolveRelayRuntimeAction(action: RemoteSshManageHostAction): RelayRuntimeAction | null {
  if (action === 'relayRuntime.status') return 'status';
  if (action === 'relayRuntime.installOrUpdate') return 'installOrUpdate';
  if (action === 'relayRuntime.start') return 'start';
  if (action === 'relayRuntime.stop') return 'stop';
  if (action === 'relayRuntime.restart') return 'restart';
  return null;
}

async function resolveRemoteSshAuth(params: Readonly<{
  ctx: Pick<Parameters<InteractiveSystemTaskKind['run']>[0], 'prompt'>;
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string | null;
}>): Promise<Readonly<{ auth: RemoteSshAuth; cleanup: (() => Promise<void>) | null }>> {
  if (params.ssh.auth === 'password') {
    const passwordFromParams = typeof params.ssh.password === 'string' ? params.ssh.password.trim() : '';
    if (passwordFromParams) {
      return {
        auth: {
          mode: 'password',
          password: passwordFromParams,
        },
        cleanup: null,
      };
    }

    const answer = await params.ctx.prompt({
      kind: 'ssh.password',
      stepId: 'ssh.password',
      message: 'SSH password required',
      data: {
        target: params.ssh.target,
      },
    }) as { password?: unknown };
    const password = typeof answer?.password === 'string' ? answer.password.trim() : '';
    if (!password) {
      throw new SystemTaskExecutionError('password_required', 'SSH password is required.');
    }
    return {
      auth: {
        mode: 'password',
        password,
      },
      cleanup: null,
    };
  }

  if (params.ssh.auth === 'keyfile') {
    const identityFile = typeof params.ssh.identityFile === 'string' ? params.ssh.identityFile.trim() : '';
    if (identityFile) {
      return {
        auth: {
          mode: 'keyFile',
          privateKeyPath: identityFile,
        },
        cleanup: null,
      };
    }

    const privateKeyMaterial = typeof params.identityPrivateKey === 'string' ? params.identityPrivateKey.trim() : '';
    if (!privateKeyMaterial) {
      throw new SystemTaskExecutionError('invalid_params', 'Missing ssh.identityFile for keyfile auth.');
    }

    const materialized = await materializeSshIdentityPrivateKeyToTempFile({
      privateKey: privateKeyMaterial,
      prefix: 'happier-ssh-manage-host-',
    });
    return {
      auth: {
        mode: 'keyFile',
        privateKeyPath: materialized.identityFilePath,
      },
      cleanup: materialized.cleanup,
    };
  }

  return { auth: { mode: 'agent' }, cleanup: null };
}

type RemoteSshManageHostParams = Readonly<{
  action: RemoteSshManageHostAction;
  channel: 'stable' | 'preview' | 'dev';
  ssh: SystemTaskSshConnectionConfig;
  identityPrivateKey?: string;
  knownHostsMode: 'app' | 'system';
  serviceMode: 'user' | 'none';
  relayRuntime?: Readonly<{
    channel?: 'stable' | 'preview' | 'dev';
    mode?: 'user' | 'system';
  }>;
}>;

function parseRemoteSshManageHostParams(params: unknown): RemoteSshManageHostParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote host params.');
  }
  const record = params as Record<string, unknown>;
  const actionRaw = typeof record.action === 'string' ? record.action.trim() : '';
  const action = actionRaw as RemoteSshManageHostAction;
  if (!isRemoteSshManageHostAction(action)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid remote host action.');
  }
  const sshRaw = record.ssh;
  const ssh = parseSystemTaskSshConfig(sshRaw);
  const sshRecord = sshRaw && typeof sshRaw === 'object' && !Array.isArray(sshRaw)
    ? (sshRaw as Record<string, unknown>)
    : null;
  const identityPrivateKey = sshRecord && typeof sshRecord.identityPrivateKey === 'string'
    ? sshRecord.identityPrivateKey.trim()
    : '';
  const channel = normalizePublicReleaseRingLabel(record.channel) || 'stable';
  const knownHostsMode = record.knownHostsMode === 'system' ? 'system' : 'app';
  const serviceMode = record.serviceMode === 'none' ? 'none' : 'user';
  const relayRuntime = record.relayRuntime && typeof record.relayRuntime === 'object' && !Array.isArray(record.relayRuntime)
    ? parseRelayRuntimeOptions(record.relayRuntime as Record<string, unknown>)
    : undefined;

  return {
    action,
    channel,
    ssh,
    ...(identityPrivateKey ? { identityPrivateKey } : {}),
    knownHostsMode,
    serviceMode,
    ...(relayRuntime ? { relayRuntime } : {}),
  };
}

function isRemoteSshManageHostAction(value: string): value is RemoteSshManageHostAction {
  return value === 'testConnection'
    || value === 'installOrUpdateCli'
    || value === 'daemonService.installOrUpdate'
    || value === 'daemonService.start'
    || value === 'daemonService.stop'
    || value === 'daemonService.restart'
    || value === 'relayRuntime.status'
    || value === 'relayRuntime.installOrUpdate'
    || value === 'relayRuntime.start'
    || value === 'relayRuntime.stop'
    || value === 'relayRuntime.restart';
}

function parseRelayRuntimeOptions(value: Record<string, unknown>): NonNullable<RemoteSshManageHostParams['relayRuntime']> {
  const channel = normalizePublicReleaseRingLabel(value.channel) || 'stable';
  const mode = value.mode === 'system' ? 'system' : 'user';
  return {
    channel,
    mode,
  };
}
