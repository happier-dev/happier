import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { withTempDir } from '@/testkit/fs/tempDir';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { resolveAcpSdkEntryFromCwd, writeFakeAcpAgentScript } from './agentModelsProbe.testkit';
import { readNativeExecutionRunOfferedModel, readExecutionRunSelectedModelStructuredOutputSupport } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { CliProbeDependencies } from './agentPreflight';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

describe('configured Agent model-probe launch failures', () => {
  it.each([false, true])('keeps a successful configured ACP Session without a model catalog eligible for prompt repair (requester: %s)', async requester => {
    await withTempDir('happier-probe-no-catalog-', async cwd => {
      const commandScript = await writeFakeAcpAgentScript({ dir: cwd,
        sdkEntry: resolveAcpSdkEntryFromCwd(process.cwd()), sessionPayloadSource: '{ sessionId: "no-catalog" }' });
      const previous = getActiveAccountSettingsSnapshot();
      const settings = accountSettingsParse({});
      const acpCatalog = { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: [{
        id: 'configured-agent', name: 'Agent', title: 'Agent',
        launch: { kind: 'command' as const, command: process.execPath, args: [commandScript] }, env: {},
        capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'no' as const,
          supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const }, createdAt: 1, updatedAt: 1,
      }] } };
      const credentials = { token: 'no-catalog-requester', encryption: null };
      const snapshot = { source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), acpCatalog };
      const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: resolveServerHttpBaseUrl(), isCurrent: async () => true });
      setActiveAccountSettingsSnapshot(requester ? { ...snapshot, settings: accountSettingsParse({}),
        scopeKey: 'different-foreground-account', acpCatalog: undefined } : snapshot);
      resetAgentModelsProbeCacheForTests();
      try {
        const backendTarget = { kind: 'configuredAcpBackend' as const, backendId: 'configured-agent' };
        const observation = await probeAgentModelsBestEffort({ agentId: 'customAcp', cwd, accountSettings: settings,
          acpCatalogSnapshot: acpCatalog, savedSecretOperationContext: operation, backendTarget });
        expect(observation).toMatchObject({ source: 'unavailable', availableModels: [] });
        expect(observation.refreshError).not.toBe(true);
        const preflightDependencies: CliProbeDependencies = { savedSecretOperationContext: operation };
        const readNativeOfferedModel = (request: Parameters<typeof readNativeExecutionRunOfferedModel>[0]) =>
          readNativeExecutionRunOfferedModel({ ...request, accountSettings: settings, promptCredentials: credentials,
            preflightDependencies });
        await expect(readExecutionRunSelectedModelStructuredOutputSupport({ backendTarget, cwd, readNativeOfferedModel }))
          .resolves.toBe(false);
      } finally {
        resetAgentModelsProbeCacheForTests();
        if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
      }
    });
  });
  it.each(process.platform === 'win32' ? ['ENOENT'] as const : ['ENOENT', 'EACCES'] as const)('projects %s without executable paths or error prose', async errno => {
    await withTempDir('happier-probe-spawn-', async cwd => {
      const previous = getActiveAccountSettingsSnapshot();
      const settings = accountSettingsParse({});
      const command = join(cwd, 'private-agent-command');
      if (errno === 'EACCES') { writeFileSync(command, 'not executable'); chmodSync(command, 0o600); }
      const acpCatalog = { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: [{
        id: 'configured-agent', name: 'Agent', title: 'Agent',
        launch: { kind: 'command' as const, command, args: [] }, env: {},
        capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'yes' as const,
          supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const }, createdAt: 1, updatedAt: 1,
      }] } };
      setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: 'spawn-probe-account', acpCatalog });
      resetAgentModelsProbeCacheForTests();
      try {
        // Real process/ACP boundary; catalog admission, probe and strict consumer remain real.
        const observation = AgentModelsProbeObservationSchema.parse(await probeAgentModelsBestEffort({ agentId: 'customAcp', cwd,
          accountSettings: settings, acpCatalogSnapshot: acpCatalog,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'configured-agent' } }));
        expect(observation).toMatchObject({ source: 'unavailable', availableModels: [], refreshError: true,
          spawnFailure: { reason: 'other', errno } });
        expect(JSON.stringify(observation)).not.toContain(command);
      } finally {
        resetAgentModelsProbeCacheForTests();
        if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
      }
    });
  });
});
