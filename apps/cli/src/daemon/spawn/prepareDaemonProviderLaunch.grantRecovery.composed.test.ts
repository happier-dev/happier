import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { accountSettingsParse, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema, ProviderSettingsV1Schema,
  setProviderExperimentalConfirmationV1 } from '@happier-dev/protocol';
import { mergeProviderCatalogV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { prepareDaemonProviderLaunch } from './prepareDaemonProviderLaunch';

it('recovers an old Session from its retained stale grant using the reconsented catalog at new launch admission', async () => {
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  const resources = createProviderLaunchResourceScope();
  const credentials = { token: 'provider-reconsent-recovery', encryption: null };
  const machineId = 'machine-recovery';
  const connectionId = ProviderConnectionIdSchema.parse('pc_recovery');
  const agentTargetKey = 'agent:happier.agent.codex/codex';
  const alpha = 'http://100.64.35.88:44557/alpha';
  const beta = 'http://100.64.35.88:44557/beta';
  const manualModel = { id: 'recovery-model', name: 'Recovery model', addedAt: 1 };
  const model = mergeProviderCatalogV1({ staticModels: [], manualModels: [manualModel],
    probeState: { snapshot: null, staleProbeModels: [] } }).rows[0]!.descriptor;
  let catalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
  let rowReads = 0;
  let boundaryError: unknown;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    } else if (request.url === '/v1/account/entity-rows/provider-connections') {
      rowReads++;
      response.end(JSON.stringify({ status: 'present', revision: 3, content: { t: 'plain', v: catalog } }));
    } else if (request.url === '/v2/account/settings') {
      response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: {} } }));
    } else if (request.url === '/v2/account/settings/history') {
      response.end(JSON.stringify({ snapshots: [] }));
    } else {
      const history = emptyAccountSettingsHistoryCaptureResponse(request.url ?? '');
      if (history) { response.statusCode = history.status; response.end(JSON.stringify(history.data)); }
      else { boundaryError = new Error(`Unexpected recovery boundary: ${request.method} ${request.url}`);
        response.statusCode = 500; response.end(JSON.stringify({ error: 'unexpected-fixture-request' })); }
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback Home');
  const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      await runtime.registry.activateContributionsOnDemand([{ pluginId: 'happier.agent.codex', family: 'agents', localId: 'codex' }]);
      const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId: 'codex' });
      if (!adapter) throw new Error('Expected real Codex binding adapter');
      const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ v: 1, id: connectionId, role: 'named', displayName: 'Recovery', displayNameMode: 'custom',
          revision: 1, createdAt: 1, updatedAt: 1, source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
            name: 'Recovery', protocol: 'openai-responses', baseUrl: alpha, catalog: 'manual' }) } }],
        manualModelsByConnectionId: { [connectionId]: [manualModel] },
      });
      const grant = (settings: typeof initial) => {
        const resolved = resolveProviderConnectionForMachine({ connectionId, machineId, providerSettings: settings,
          registry: runtime.registry.contributes, dnsEvidenceByEndpointUrl: new Map() });
        if (resolved.status !== 'resolved') throw new Error(`Expected private Provider: ${resolved.status}`);
        let granted = ProviderSettingsV1Schema.parse({ ...settings, machineGrants: [{ v: 1, connectionId, machineId,
          connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
          endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 2 }] });
        const compatibility = resolveProviderModelCompatibility({ record: resolved.record, providerSettings: granted,
          agentTargetKey, support: adapter.support, adapterVersion: adapter.adapter.adapterVersion, model });
        if (compatibility.result.status === 'experimental') granted = setProviderExperimentalConfirmationV1(granted, {
          connectionId, agentTargetKey, modelId: compatibility.result.confirmationScope.kind === 'model' ? model.id : null,
          compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmedAt: 2 });
        return granted;
      };
      const alphaSettings = grant(initial);
      const betaSettings = grant(ProviderSettingsV1Schema.parse({ ...alphaSettings, connections: alphaSettings.connections.map(connection => ({
        ...connection, revision: 2, endpointOverridesByMachineId: { [machineId]: [{
          endpointTemplateId: connection.source.kind === 'custom' ? connection.source.template.endpointTemplates[0]!.id : '', baseUrl: beta,
        }] },
      })) }));
      catalog = splitProviderSettingsV1(betaSettings).catalog;
      const snapshot = (settings: typeof initial): ActiveAccountSettingsSnapshot => ({ source: 'network',
        settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        providerConnectionsCatalog: { status: 'ready', revision: 2, catalog: splitProviderSettingsV1(settings).catalog } });
      const executable = await writeExecutableShim({ dir: runtime.happyHomeDir,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n' });
      const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
      const common = { effectiveBackendTarget: backendTarget, catalogAgentId: 'codex' as const,
        modelSelection: { v: 1 as const, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: connectionId, modelId: model.id } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        pluginRuntimeLease: { currentRegistry: runtime.registry, acquire: async () => runtime.lease, release: async () => {} },
        launchResourceScope: resources, resolveProvidersFeatureEnabled: () => true, providerRuntimeHomeDir: runtime.happyHomeDir,
        processEnv: { [resolveAgentCliOverrideEnvKey('codex')]: executable } };
      const options = { directory: runtime.happyHomeDir, machineId, backendTarget };
      const before = await prepareDaemonProviderLaunch({ ...common, options, persistedProviderBinding: null,
        normalizedExistingSessionId: '', accountSettingsSnapshot: snapshot(alphaSettings) });
      const preview = await prepareDaemonProviderLaunch({ ...common, options, persistedProviderBinding: null,
        normalizedExistingSessionId: '', accountSettingsSnapshot: snapshot(betaSettings) });
      if (!before.ok || !before.attempt || !preview.ok || !preview.attempt) throw new Error('Expected both granted bindings to admit');
      const previous = before.attempt.authorization.sessionBindingMetadata;
      const next = preview.attempt.authorization.sessionBindingMetadata;
      const context = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl, isCurrent: async () => true,
        snapshot: snapshot(ProviderSettingsV1Schema.parse({ ...betaSettings, machineGrants: alphaSettings.machineGrants })) });
      const refused = await prepareDaemonProviderLaunch({ ...common,
        options: { ...options, existingSessionId: 'old-session' },
        persistedProviderBinding: previous, normalizedExistingSessionId: 'old-session',
        readAccountSettingsSnapshot: context.readSnapshot, savedSecretOperationContext: context });
      expect(refused).toMatchObject({ ok: false, result: { errorDetail: { providerError: { code: 'provider_machine_grant_stale' } } } });
      expect(rowReads).toBe(0);
      const recovery = await prepareDaemonProviderLaunch({ ...common,
        options: { ...options, existingSessionId: 'old-session', providerBindingSecurityChangeConfirmationV1: {
          v: 1, sessionId: 'old-session', connectionId: previous.connectionId,
          previousBindingSecurityFingerprint: previous.bindingSecurityFingerprint,
          nextBindingSecurityFingerprint: next.bindingSecurityFingerprint,
        } }, persistedProviderBinding: previous, normalizedExistingSessionId: 'old-session',
        readAccountSettingsSnapshot: context.readSnapshot, savedSecretOperationContext: context });
      expect(recovery, JSON.stringify(recovery)).toMatchObject({ ok: true });
      if (!recovery.ok || !recovery.attempt) throw new Error('Expected recovered Provider admission');
      expect(recovery.attempt.authorization.binding.endpoint).toMatchObject({ normalizedUrl: beta });
      expect(recovery.attempt.authorization.sessionBindingMetadata.bindingSecurityFingerprint).toBe(next.bindingSecurityFingerprint);
      expect(rowReads).toBe(1);
      expect(boundaryError).toBeUndefined();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await resources.release();
    await runtime.dispose();
  }
});
