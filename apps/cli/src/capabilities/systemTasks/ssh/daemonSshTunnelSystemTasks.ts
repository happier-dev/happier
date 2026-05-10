import {
  SshTunnelEnsureRequestSchema,
  SshTunnelReleaseRequestSchema,
  SshTunnelStopRequestSchema,
  SystemTaskJsonValueSchema,
  type SystemTaskJsonValue,
} from '@happier-dev/protocol';
import {
  SystemTaskExecutionError,
  type InteractiveSystemTaskKind,
} from '@happier-dev/cli-common/systemTasks';

import {
  ensureDaemonSshTunnel,
  listDaemonSshTunnels,
  releaseDaemonSshTunnel,
  stopDaemonSshTunnel,
} from '@/daemon/controlClient';

type ControlErrorResponse = Readonly<{
  error: string;
  errorCode?: string;
}>;

function isControlError(response: unknown): response is ControlErrorResponse {
  return Boolean(
    response
    && typeof response === 'object'
    && typeof (response as { error?: unknown }).error === 'string',
  );
}

function throwIfControlError(response: unknown): void {
  if (!isControlError(response)) return;
  throw new SystemTaskExecutionError(
    response.errorCode ?? 'ssh_tunnel_control_failed',
    response.error,
  );
}

function toSystemTaskJsonValue(response: unknown): SystemTaskJsonValue {
  const parsed = SystemTaskJsonValueSchema.safeParse(response);
  if (!parsed.success) {
    throw new SystemTaskExecutionError('invalid_daemon_response', 'Daemon SSH tunnel response was not JSON-safe.');
  }
  return parsed.data;
}

export function createDaemonSshTunnelEnsureTaskKind(deps: Readonly<{
  ensureDaemonSshTunnel?: typeof ensureDaemonSshTunnel;
}> = {}): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  const ensure = deps.ensureDaemonSshTunnel ?? ensureDaemonSshTunnel;
  return {
    run: async (ctx) => {
      const parsed = SshTunnelEnsureRequestSchema.safeParse(ctx.params);
      if (!parsed.success) {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid SSH tunnel ensure request.');
      }
      const response = await ensure(parsed.data);
      throwIfControlError(response);
      return toSystemTaskJsonValue(response);
    },
  };
}

export function createDaemonSshTunnelListTaskKind(deps: Readonly<{
  listDaemonSshTunnels?: typeof listDaemonSshTunnels;
}> = {}): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  const list = deps.listDaemonSshTunnels ?? listDaemonSshTunnels;
  return {
    run: async () => {
      const response = await list();
      throwIfControlError(response);
      return toSystemTaskJsonValue(response);
    },
  };
}

export function createDaemonSshTunnelReleaseTaskKind(deps: Readonly<{
  releaseDaemonSshTunnel?: typeof releaseDaemonSshTunnel;
}> = {}): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  const release = deps.releaseDaemonSshTunnel ?? releaseDaemonSshTunnel;
  return {
    run: async (ctx) => {
      const parsed = SshTunnelReleaseRequestSchema.safeParse(ctx.params);
      if (!parsed.success) {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid SSH tunnel release request.');
      }
      const response = await release(parsed.data.leaseId);
      throwIfControlError(response);
      return toSystemTaskJsonValue(response);
    },
  };
}

export function createDaemonSshTunnelStopTaskKind(deps: Readonly<{
  stopDaemonSshTunnel?: typeof stopDaemonSshTunnel;
}> = {}): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  const stop = deps.stopDaemonSshTunnel ?? stopDaemonSshTunnel;
  return {
    run: async (ctx) => {
      const parsed = SshTunnelStopRequestSchema.safeParse(ctx.params);
      if (!parsed.success) {
        throw new SystemTaskExecutionError('invalid_params', 'Invalid SSH tunnel stop request.');
      }
      const response = await stop(parsed.data.tunnelKey);
      throwIfControlError(response);
      return toSystemTaskJsonValue(response);
    },
  };
}
