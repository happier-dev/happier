import { resolveAgentNativeSpawnDefinitiveRejection } from '@/providers/spawn/currentDefinitiveRejection';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { describe, expect, it } from 'vitest';
import { prepareDaemonProviderLaunch } from './prepareDaemonProviderLaunch';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

describe('native spawn selection diagnostics', () => {
  it('offers the captured explicit model policy and admits it instead of rejecting against default alone', async () => {
    const catalog = await probeAgentModelsBestEffort({ agentId: 'qwen', cwd: '/workspace', env: {} });
    expect(catalog).toMatchObject({ supportsFreeform: true });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ agentId: 'qwen',
      selection: { modelId: 'gpt-4.1-nano', providerConnectionId: null } })).toEqual({ ok: true });
  });
  it.each([
    { options: {}, code: 'agent_startup_model_reconciliation_failed', reason: 'model_selection_invalid', nativeCode: 'model_not_selectable' },
    { options: { agentModeId: '' }, code: 'agent_startup_invalid_state', reason: 'session_configuration_invalid', nativeCode: 'session_mode_not_selectable' },
    { options: { sessionConfigOptionOverrides: { v: 1 as const, updatedAt: Number.NaN, overrides: {} } }, code: 'agent_startup_invalid_state', reason: 'session_configuration_invalid', nativeCode: 'session_config_invalid' },
  ])('preserves $nativeCode through the public spawn result before runtime acquisition', async ({ options, code, reason, nativeCode }) => {
    const target = { kind: 'agent', identity: { pluginId: 'happier.agent.qwen', localId: 'qwen' } } as const;
    const scope = createProviderLaunchResourceScope();
    try {
      const result = await prepareDaemonProviderLaunch({
        options: { directory: '/workspace', backendTarget: target, ...options }, effectiveBackendTarget: target,
        catalogAgentId: 'qwen', modelSelection: { v: 1, updatedAt: 1794595150491,
          ref: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: null, modelId: '' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
        normalizedExistingSessionId: '', processEnv: {}, launchResourceScope: scope,
        pluginRuntimeLease: { currentRegistry: null, acquire: async () => { throw new Error('Invalid input must refuse before activation'); }, release: async () => {} },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected selection refusal');
      expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure(result.result)))
        .toMatchObject({ type: 'error', retryable: false, launchError: {
          code,
          failureCause: { phase: 'client_start', failureReason: reason, providerErrorCode: nativeCode, retryable: false },
        } });
    } finally { await scope.release(); }
  });
});
