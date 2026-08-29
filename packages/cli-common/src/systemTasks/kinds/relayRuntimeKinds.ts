import type { SystemTaskJsonValue } from '@happier-dev/protocol';
import { normalizePublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import {
  assertPersonalHomeEnvironmentKeys,
  parsePersonalHomeRuntimePurpose,
  type ManagedRelayPurpose,
} from '../../firstPartyRuntime/personalHome/personalHomeRuntimeSpec.js';
import type { PersonalHomeRuntimeLayout } from '../../firstPartyRuntime/personalHome/layout.js';

export interface SystemTaskSshConnectionConfig {
  target: string;
  port?: number;
  auth: 'agent' | 'keyfile' | 'password';
  identityFile?: string;
  password?: string;
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
  purpose?: ManagedRelayPurpose;
  operation?: 'backup' | 'verify_backup' | 'restore' | 'erase' | 'relocate' | 'uninstall';
  confirmErase?: boolean;
  archivePath?: string;
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
  warnings?: readonly string[];
  purpose?: ManagedRelayPurpose;
  canonicalServerUrl?: string;
  layout?: PersonalHomeRuntimeLayout;
  dataPresent?: boolean;
}

type RelayRuntimeStatusResult = Readonly<{
  installed: boolean;
  version: string | null;
  relayUrl: string;
  healthy: boolean;
  service: RelayRuntimeStatusSnapshot['service'];
  warnings?: readonly string[];
}>;

export type RelayRuntimeKindDeps = Readonly<{
  readStatus: (params: RelayRuntimeTaskParams) => Promise<RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>) => Promise<void>;
  personalHomeOperation?: (params: RelayRuntimeTaskParams) => Promise<SystemTaskJsonValue>;
}>;

export function createPersonalHomeOperationTaskKind(deps: Pick<RelayRuntimeKindDeps, 'personalHomeOperation'>): InteractiveSystemTaskKind<SystemTaskJsonValue> {
  return { async run(ctx) { const parsed = parseRelayRuntimeTaskParams(ctx.params); if (!parsed.operation || parsed.operation === 'verify_backup' && !parsed.archivePath) throw new SystemTaskExecutionError('invalid_params', 'Personal Home operation and archivePath are required.'); ctx.emit({ type: 'progress', stepId: `personal_home.${parsed.operation}`, message: `Running Personal Home ${parsed.operation ?? 'operation'}` }); if (!deps.personalHomeOperation) throw new SystemTaskExecutionError('unsupported', 'Personal Home operations are unavailable.'); return deps.personalHomeOperation(parsed); } };
}

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

export function createRelayRuntimeRestartTaskKind(deps: Pick<RelayRuntimeKindDeps, 'control' | 'readStatus' | 'checkHealth'>): InteractiveSystemTaskKind<RelayRuntimeStatusResult> {
  return {
    async run(ctx) {
      const parsed = parseRelayRuntimeTaskParams(ctx.params);
      ctx.emit({ type: 'progress', stepId: 'relay.restart', message: 'Restarting relay runtime' });
      await deps.control({ ...parsed, action: 'restart' });
      const snapshot = await deps.readStatus(parsed);
      ctx.emit({ type: 'progress', stepId: 'relay.status.health', message: 'Checking relay runtime health' });
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
    ...(snapshot.warnings && snapshot.warnings.length > 0 ? { warnings: snapshot.warnings } : {}),
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
  const channel = normalizePublicReleaseRingLabel(value.channel) || 'stable';
  const mode = value.mode === 'system' ? 'system' : 'user';
  const env = typeof value.env === 'object' && value.env && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env as Record<string, unknown>).map(([key, innerValue]) => [key, String(innerValue ?? '')]))
    : undefined;
  const selfHostRelayBinaryOverride = typeof value.selfHostRelayBinaryOverride === 'string'
    ? value.selfHostRelayBinaryOverride
    : undefined;
  const operation = ['backup', 'verify_backup', 'restore', 'erase', 'relocate', 'uninstall'].includes(String(value.operation)) ? value.operation as RelayRuntimeTaskParams['operation'] : undefined;
  const confirmErase = value.confirmErase === true;
  const archivePath = typeof value.archivePath === 'string' ? value.archivePath : undefined;
  const purpose = value.purpose === undefined
    ? undefined
    : (() => {
        const spec = parsePersonalHomeRuntimePurpose(value.purpose);
        return { kind: 'personal-home' as const, canonicalServerUrl: spec.canonicalServerUrl };
      })();
  if (purpose?.kind === 'personal-home') {
    assertPersonalHomeEnvironmentKeys(env ?? {});
  }

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
    ...(purpose ? { purpose } : {}),
    ...(operation ? { operation } : {}),
    ...(confirmErase ? { confirmErase } : {}),
    ...(archivePath ? { archivePath } : {}),
  };
}

export function parseSystemTaskSshConfig(value: unknown): SystemTaskSshConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid ssh config.');
  }
  const record = value as Record<string, unknown>;
  const auth = record.auth === 'keyfile'
    ? 'keyfile'
    : record.auth === 'password'
      ? 'password'
      : 'agent';
  return {
    target: ensureNonEmptyString(record.target, 'ssh.target'),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    auth,
    ...(typeof record.identityFile === 'string' ? { identityFile: record.identityFile } : {}),
    ...(typeof record.password === 'string' ? { password: record.password } : {}),
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
