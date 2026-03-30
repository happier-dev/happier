import type { SystemTaskJsonValue } from '@happier-dev/protocol';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';

export interface SystemTaskSshConnectionConfig {
  target: string;
  port?: number;
  auth: 'agent' | 'keyfile';
  identityFile?: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  trustedHostKey?: string;
}

export interface RelayRuntimeTaskParams {
  target: Readonly<{ kind: 'local' }> | Readonly<{ kind: 'ssh'; ssh: SystemTaskSshConnectionConfig }>;
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
  env?: Record<string, string>;
  selfHostRelayBinaryOverride?: string;
}

export interface RelayRuntimeStatusSnapshot {
  installed: boolean;
  version: string | null;
  service: Readonly<{
    active: boolean | null;
    enabled: boolean | null;
  }>;
  baseUrl: string;
  healthy?: boolean | null;
}

type RelayRuntimeStatusResult = Readonly<{
  installed: boolean;
  version: string | null;
  relayUrl: string;
  healthy: boolean;
  service: RelayRuntimeStatusSnapshot['service'];
}>;

export type RelayRuntimeKindDeps = Readonly<{
  readStatus: (params: RelayRuntimeTaskParams) => Promise<RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>) => Promise<void>;
}>;

export function createRelayRuntimeStatusTaskKind(deps: Pick<RelayRuntimeKindDeps, 'readStatus' | 'checkHealth'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      });

      const snapshot = await deps.readStatus(parsed);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      });

      return await buildRelayRuntimeStatusResult(snapshot, deps.checkHealth);
    },
  };
}

export function createRelayRuntimeInstallOrUpdateTaskKind(deps: Pick<RelayRuntimeKindDeps, 'installOrUpdate'>): InteractiveSystemTaskKind<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.install',
        message: 'Installing relay runtime',
      });

      return await deps.installOrUpdate(parsed);
    },
  };
}

export function createRelayRuntimeStartTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'readStatus' | 'checkHealth'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.start',
        message: 'Starting relay runtime',
      });

      await deps.control({
        ...parsed,
        action: 'start',
      });

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      });

      const snapshot = await deps.readStatus(parsed);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      });

      return await buildRelayRuntimeStatusResult(snapshot, deps.checkHealth);
    },
  };
}

export function createRelayRuntimeStopTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control'>): InteractiveSystemTaskKind<Readonly<{ stopped: true }>> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.stop',
        message: 'Stopping relay runtime',
      });

      await deps.control({
        ...parsed,
        action: 'stop',
      });

      return {
        stopped: true,
      };
    },
  };
}

async function buildRelayRuntimeStatusResult(
  snapshot: RelayRuntimeStatusSnapshot,
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>,
): Promise<RelayRuntimeStatusResult> {
  const healthy = typeof snapshot.healthy === 'boolean'
    ? snapshot.healthy
    : await checkHealth({ baseUrl: snapshot.baseUrl });

  return {
    installed: snapshot.installed,
    version: snapshot.version,
    relayUrl: snapshot.baseUrl,
    healthy,
    service: snapshot.service,
  };
}

export function parseRelayRuntimeTaskParams(params: unknown): RelayRuntimeTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay runtime params.');
  }
  const value = params as Record<string, unknown>;
  const target = value.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay runtime target.');
  }

  const targetRecord = target as Record<string, unknown>;
  const kind = targetRecord.kind === 'ssh' ? 'ssh' : 'local';
  const channel = value.channel === 'preview' || value.channel === 'dev' ? value.channel : 'stable';
  const mode = value.mode === 'system' ? 'system' : 'user';
  const env = typeof value.env === 'object' && value.env && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env as Record<string, unknown>).map(([key, innerValue]) => [key, String(innerValue ?? '')]))
    : undefined;
  const selfHostRelayBinaryOverride = typeof value.selfHostRelayBinaryOverride === 'string'
    ? value.selfHostRelayBinaryOverride
    : undefined;

  return {
    target: kind === 'local'
      ? { kind: 'local' }
      : {
          kind: 'ssh',
          ssh: parseSystemTaskSshConfig(targetRecord.ssh),
        },
    channel,
    mode,
    ...(env ? { env } : {}),
    ...(selfHostRelayBinaryOverride ? { selfHostRelayBinaryOverride } : {}),
  };
}

export function parseSystemTaskSshConfig(value: unknown): SystemTaskSshConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid ssh config.');
  }
  const record = value as Record<string, unknown>;
  const auth = record.auth === 'keyfile' ? 'keyfile' : 'agent';
  return {
    target: ensureNonEmptyString(record.target, 'ssh.target'),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    auth,
    ...(typeof record.identityFile === 'string' ? { identityFile: record.identityFile } : {}),
    ...(typeof record.sshConfigFile === 'string' ? { sshConfigFile: record.sshConfigFile } : {}),
    ...(typeof record.knownHostsPath === 'string' ? { knownHostsPath: record.knownHostsPath } : {}),
    ...(typeof record.trustedHostKey === 'string' ? { trustedHostKey: record.trustedHostKey } : {}),
  };
}

function ensureNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new SystemTaskExecutionError('invalid_params', `Missing ${field}.`);
  }
  return text;
}
