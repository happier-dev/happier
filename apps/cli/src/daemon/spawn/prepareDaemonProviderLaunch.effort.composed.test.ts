import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';

import { describe, expect, it, vi } from 'vitest';
import {
  accountSettingsParse,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  setProviderExperimentalConfirmationV1,
} from '@happier-dev/protocol';
import { mergeProviderCatalogV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { prepareDaemonProviderLaunch } from './prepareDaemonProviderLaunch';
import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';
import type { ApiClient } from '@/api/api';
import { projectSpawnSessionControlErrorResponse, SpawnSessionControlErrorResponseSchema } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

// The DNS system boundary returns public addresses without network access.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: async () => [{ address: '1.1.1.1', family: 4 }],
}));

describe('Session Provider effort admission through real authorization', () => {
  it.each([
    { effort: 'ultra', admitted: false, missingExecutable: false, accountSource: 'captured' },
    { effort: 'high', admitted: true, missingExecutable: false, accountSource: 'captured' },
    { effort: 'high', admitted: false, missingExecutable: true, accountSource: 'captured' },
    { effort: 'high', admitted: true, missingExecutable: false, accountSource: 'active' },
  ])('admits declared effort and preserves prerequisite refusal before launch effects ($effort, missing CLI: $missingExecutable, Account: $accountSource)', async ({ effort, admitted, missingExecutable, accountSource }) => {
    // DNS and credential transport are replaced boundaries; catalog, runtime activation, model
    // compatibility and launch authorization all use their production owners.
    const runtime = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
    const scope = createProviderLaunchResourceScope();
    try {
      await runtime.registry.activateContributionsOnDemand([{
        pluginId: 'happier.agent.codex', family: 'agents', localId: 'codex',
      }]);
      const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId: 'codex' });
      if (!adapter) throw new Error('Expected the real Codex Provider adapter');
      const connectionId = ProviderConnectionIdSchema.parse('pc_effort_session');
      const agentTargetKey = 'agent:happier.agent.codex/codex';
      const manualModels = [{ id: 'tier-projection-01', name: 'Declared tiers',
        reasoningEffortLevels: ['low', 'medium', 'high'], addedAt: 1 }];
      const initial = ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ v: 1, id: connectionId,
          source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
            name: 'Effort fixture', protocol: 'openai-responses',
            baseUrl: 'https://effort.example.test/v1', catalog: 'manual',
          }) }, role: 'named', displayName: 'Effort fixture', displayNameMode: 'custom',
          revision: 1, createdAt: 1, updatedAt: 1 }],
        manualModelsByConnectionId: { [connectionId]: manualModels },
      });
      const registry = { providersByContributionKey: runtime.registry.contributes.providersByContributionKey ?? new Map() };
      const resolution = resolveProviderConnectionForMachine({
        connectionId, machineId: 'machine-effort', providerSettings: initial, registry,
        dnsEvidenceByEndpointUrl: new Map([['https://effort.example.test/v1', ['1.1.1.1']]]),
      });
      if (resolution.status !== 'resolved') throw new Error(`Expected connection: ${resolution.status}`);
      const granted = ProviderSettingsV1Schema.parse({ ...initial,
        accountGrants: [{ v: 1, connectionId,
          connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint, confirmedAt: 1 }],
      });
      const model = mergeProviderCatalogV1({ staticModels: [],
        manualModels: granted.manualModelsByConnectionId[connectionId]!,
        probeState: { snapshot: null, staleProbeModels: [] } }).rows[0]!.descriptor;
      const compatibility = resolveProviderModelCompatibility({ record: resolution.record,
        providerSettings: granted, agentTargetKey, support: adapter.support,
        adapterVersion: adapter.adapter.adapterVersion, model });
      const settings = compatibility.result.status === 'experimental'
        ? setProviderExperimentalConfirmationV1(granted, { connectionId, agentTargetKey,
            modelId: compatibility.result.confirmationScope.kind === 'model' ? model.id : null,
            compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmedAt: 1 })
        : granted;
      const snapshot: ActiveAccountSettingsSnapshot = {
        source: 'network', settings: accountSettingsParse({ providerSettingsV1: settings }),
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-effort',
      };
      if (accountSource === 'active') setActiveAccountSettingsSnapshot(snapshot);
      const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
      const executable = await writeExecutableShim({
        dir: runtime.happyHomeDir,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? '@echo off\r\necho 1.0.0\r\n'
          : '#!/bin/sh\necho 1.0.0\n',
      });
      const launch = await prepareDaemonProviderLaunch({
        options: { directory: runtime.happyHomeDir, machineId: 'machine-effort', backendTarget,
          connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'unavailable-native-pool' },
          } },
          sessionConfigOptionOverrides: { v: 1, updatedAt: 1,
            overrides: { reasoning_effort: { value: effort, updatedAt: 1 } } } },
        effectiveBackendTarget: backendTarget, catalogAgentId: 'codex',
        modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
        normalizedExistingSessionId: '',
        pluginRuntimeLease: { currentRegistry: runtime.registry, acquire: async () => runtime.lease, release: async () => {} },
        launchResourceScope: scope, resolveProvidersFeatureEnabled: () => true,
        ...(accountSource === 'captured' ? { accountSettingsSnapshot: snapshot } : {}),
        providerRuntimeHomeDir: runtime.happyHomeDir,
        processEnv: { [resolveAgentCliOverrideEnvKey('codex')]: missingExecutable
          ? join(runtime.happyHomeDir, 'missing-agent-cli') : executable,
          ...(missingExecutable ? { PATH: '' } : {}) },
      });
      if (launch.ok) launch.attempt?.cleanupOnFailure();
      if (admitted) {
        if (!launch.ok || !launch.attempt) throw new Error('Expected successful Provider authorization');
        expect(launch.attempt.authorization.binding.selection).toMatchObject({ connectionId, model: { id: model.id } });
        expect(launch).toMatchObject({ ok: true, options: {
          sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: effort } } },
        } });
        // Continue through the real next spawn phase: suppression must survive
        // admission without reading the unavailable native pool or credentials.
        const api = new Proxy({} as ApiClient, {
          get() { throw new Error('Provider-bound launch must not acquire native credentials'); },
        });
        const connected = await prepareDaemonConnectedServices({
          options: launch.options, normalizedExistingSessionId: '', requestedSessionId: 'provider-bound-session',
          effectiveResume: '', catalogAgentId: 'codex', credentials: { token: 'fixture', encryption: null }, api,
          connectedServiceRefreshCoordinator: null, processEnv: {}, pluginRuntimeRegistry: runtime.registry,
          connectedServicesMaterializationBaseDir: join(runtime.happyHomeDir, 'connected-materialized'),
        });
        expect(connected, JSON.stringify(connected)).toMatchObject({ ok: true, auth: null });
        expect(launch.options.connectedServices).toEqual({ v: 2, bindingsByServiceId: {} });
      } else if (missingExecutable) {
        if (launch.ok) throw new Error('Missing CLI unexpectedly admitted');
        const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(launch.result));
        expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
          errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
          agentId: response.agentId,
        }))).toMatchObject({ type: 'error', code: 'agent_cli_missing', agentId: 'codex' });
        expect(launch).toMatchObject({ ok: false, result: {
          type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING, agentId: 'codex',
        } });
      } else expect(launch).toMatchObject({ ok: false, result: {
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorDetail: { kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR, providerError: {
          code: 'provider_model_config_option_unsupported', retryable: false,
          connectionId, machineId: 'machine-effort',
        } },
      } });
      expect(await readdir(join(runtime.happyHomeDir, 'providers', 'materialized')).catch(() => [])).toEqual([]);
    } finally {
      await scope.release();
      await runtime.dispose();
      if (accountSource === 'active') resetActiveAccountSettingsSnapshotForTests();
    }
  });
});
