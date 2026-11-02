import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';
import { normalizeRelayAccessCanonicalPublicServerUrl } from '../../relayAccess/normalizePublicServerUrl.js';
import type { AccessProviderRefV1 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { projectRelayAccessConfigV1, type RelayAccessTaskSnapshotV1 } from '@happier-dev/protocol/system/tasks/relayAccessConfigV1';
import { parseRelayAccessConfig, readBuiltinRelayAccessProviderId, relayAccessProviderDescriptors } from '../../relayAccess/catalog.js';

import { SystemTaskExecutionError } from '../runSystemTask.js';
import { redactSensitiveSystemTaskJsonValue, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import { parseSystemTaskSshConfig, type SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';

import type {
  RelayAccessConfig,
  RelayAccessExecutionContext,
  RelayAccessProvider,
  RelayAccessStatus,
} from '../../relayAccess/types.js';

export type RelayAccessTaskTarget =
  | Readonly<{ kind: 'local' }>
  | Readonly<{ kind: 'ssh'; ssh: SystemTaskSshConnectionConfig }>;

export type RelayAccessStatusSnapshot = Readonly<{
  state: RelayAccessStatus['state'];
  shareUrl: string | null;
  details: SystemTaskJsonValue | null;
}>;

export type RelayAccessTaskSnapshot = Readonly<RelayAccessTaskSnapshotV1>;

export type RelayAccessStatusTaskParams = Readonly<{
  target: RelayAccessTaskTarget;
}>;

export type RelayAccessConfigureTaskParams = Readonly<{
  target: RelayAccessTaskTarget;
  upstreamUrl: string | null;
  config: RelayAccessConfig;
}>;

export type RelayAccessDisableTaskParams = Readonly<{
  target: RelayAccessTaskTarget;
}>;

export type RelayAccessStatusKindDeps = Readonly<{
  readConfig: (params: Readonly<{ target: RelayAccessTaskTarget }>) => Promise<RelayAccessConfig | null>;
  getProvider: (provider: AccessProviderRefV1) => RelayAccessProvider;
  createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => RelayAccessExecutionContext;
}>;

export type RelayAccessConfigureKindDeps = Readonly<{
  writeConfig: (params: Readonly<{ target: RelayAccessTaskTarget; config: RelayAccessConfig }>) => Promise<void>;
  getProvider: (provider: AccessProviderRefV1) => RelayAccessProvider;
  createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => RelayAccessExecutionContext;
}>;

export type RelayAccessDisableKindDeps = Readonly<{
  readConfig: (params: Readonly<{ target: RelayAccessTaskTarget }>) => Promise<RelayAccessConfig | null>;
  writeConfig: (params: Readonly<{ target: RelayAccessTaskTarget; config: RelayAccessConfig | null }>) => Promise<void>;
  getProvider: (provider: AccessProviderRefV1) => RelayAccessProvider;
  createExecutionContext: (params: Readonly<{ target: RelayAccessTaskTarget; upstreamUrl: string | null }>) => RelayAccessExecutionContext;
}>;

export function createRelayAccessStatusTaskKind(deps: RelayAccessStatusKindDeps): InteractiveSystemTaskKind<RelayAccessTaskSnapshot> {
  return {
    async run(ctx) {
      const parsed = parseRelayAccessStatusParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.access.status.inspect',
        message: 'Inspecting relay access configuration',
      });

      const config = await deps.readConfig({ target: parsed.target });
      if (!config) {
        return buildDisabledRelayAccessSnapshot();
      }

      ctx.emit({
        type: 'progress',
        stepId: 'relay.access.status.check',
        message: 'Checking relay access provider status',
      });

      const provider = deps.getProvider(config.provider);
      const status = await provider.status({
        config,
        ctx: deps.createExecutionContext({ target: parsed.target, upstreamUrl: null }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        configured: true,
        providerId: readBuiltinRelayAccessProviderId(config.provider),
        selection: projectRelayAccessConfigV1(config),
        status: normalizeRelayAccessStatus(status),
      };
    },
  };
}

export function createRelayAccessConfigureTaskKind(deps: RelayAccessConfigureKindDeps): InteractiveSystemTaskKind<RelayAccessTaskSnapshot> {
  return {
    async run(ctx) {
      const parsed = parseRelayAccessConfigureParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.access.configure.persist',
        message: 'Saving relay access configuration',
      });

      await deps.writeConfig({
        target: parsed.target,
        config: parsed.config,
      });

      const executionContext = deps.createExecutionContext({ target: parsed.target, upstreamUrl: parsed.upstreamUrl });
      const provider = deps.getProvider(parsed.config.provider);
      if (provider.configure) {
        ctx.emit({
          type: 'progress',
          stepId: 'relay.access.configure.apply',
          message: 'Applying relay access configuration',
        });
        const configureResult = await provider.configure({
          config: parsed.config,
          ctx: executionContext,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (configureResult.state === 'needs_auth' || configureResult.state === 'error') {
          return {
            configured: true,
            providerId: readBuiltinRelayAccessProviderId(parsed.config.provider),
            selection: projectRelayAccessConfigV1(parsed.config),
            status: normalizeRelayAccessStatus(configureResult),
          };
        }
      }

      ctx.emit({
        type: 'progress',
        stepId: 'relay.access.configure.verify',
        message: 'Checking relay access provider status',
      });

      const status = await provider.status({
        config: parsed.config,
        ctx: executionContext,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        configured: true,
        providerId: readBuiltinRelayAccessProviderId(parsed.config.provider),
        selection: projectRelayAccessConfigV1(parsed.config),
        status: normalizeRelayAccessStatus(status),
      };
    },
  };
}

export function createRelayAccessDisableTaskKind(deps: RelayAccessDisableKindDeps): InteractiveSystemTaskKind<RelayAccessTaskSnapshot> {
  return {
    async run(ctx) {
      const parsed = parseRelayAccessDisableParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'relay.access.disable',
        message: 'Disabling relay access provider',
      });

      const config = await deps.readConfig({ target: parsed.target });
      if (config) {
        const provider = deps.getProvider(config.provider);
        if (provider.disable) {
          await provider.disable({
            config,
            ctx: deps.createExecutionContext({ target: parsed.target, upstreamUrl: null }),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        }
      }

      await deps.writeConfig({
        target: parsed.target,
        config: null,
      });

      return buildDisabledRelayAccessSnapshot();
    },
  };
}

export function parseRelayAccessStatusParams(params: unknown): RelayAccessStatusTaskParams {
  const target = parseRelayAccessTarget(params);
  return { target };
}

export function parseRelayAccessDisableParams(params: unknown): RelayAccessDisableTaskParams {
  const target = parseRelayAccessTarget(params);
  return { target };
}

export function parseRelayAccessConfigureParams(params: unknown): RelayAccessConfigureTaskParams {
  const base = ensureObject(params, 'relay.access.configure');
  const target = parseRelayAccessTarget(params);

  if (Object.keys(base).some(key => !['target', 'config', 'upstreamUrl'].includes(key))) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay access configuration.');
  }
  const config = parseRelayAccessConfig(base.config, relayAccessProviderDescriptors.filter(descriptor =>
    descriptor.definition.targets.includes('homeRelay')));
  if (!config) throw new SystemTaskExecutionError('invalid_params', 'Invalid relay access selection.');

  return {
    target,
    upstreamUrl: typeof base.upstreamUrl === 'string' ? base.upstreamUrl.trim() || null : null,
    config,
  };
}

export function redactRelayAccessParams(params: Record<string, unknown>): SystemTaskJsonObject {
  return redactSensitiveSystemTaskJsonValue(params) as SystemTaskJsonObject;
}

function buildDisabledRelayAccessSnapshot(): RelayAccessTaskSnapshot {
  return {
    configured: false,
    providerId: null,
    selection: null,
    status: {
      state: 'disabled',
      shareUrl: null,
      details: null,
    },
  };
}

function normalizeRelayAccessStatus(status: RelayAccessStatus): RelayAccessStatusSnapshot {
  const shareUrl = typeof status.shareUrl === 'string' && status.shareUrl.trim().length > 0
    ? normalizeRelayAccessCanonicalPublicServerUrl(status.shareUrl)
    : null;
  const details = typeof status.details === 'undefined'
    ? null
    : (redactSensitiveSystemTaskJsonValue(status.details) as SystemTaskJsonValue);
  return {
    state: status.state,
    shareUrl,
    details,
  };
}

function parseRelayAccessTarget(params: unknown): RelayAccessTaskTarget {
  const value = ensureObject(params, 'relay.access.target');
  const targetRaw = value.target;
  if (!targetRaw || typeof targetRaw !== 'object' || Array.isArray(targetRaw)) {
    throw new SystemTaskExecutionError('invalid_params', 'Invalid relay access target.');
  }
  const targetRecord = targetRaw as Record<string, unknown>;
  if (targetRecord.kind === 'ssh') {
    return {
      kind: 'ssh',
      ssh: parseSystemTaskSshConfig(targetRecord.ssh),
    };
  }
  return { kind: 'local' };
}

function ensureObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemTaskExecutionError('invalid_params', `Invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}
