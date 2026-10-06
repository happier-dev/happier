import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createProviderErrorV1, redactBugReportSensitiveText } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { consumeProviderBindingLaunchHandoffFromEnvironments } from '@/plugins/runtime/providerBindings/handoff';
import { createProviderBindingLaunchMaterializationCleanup } from '@/providers/spawn/compose';
import { withForegroundProviderFixture } from './prepareForegroundAdmission.providers.testkit';

afterEach(() => vi.restoreAllMocks());

describe('foreground admission composed real Provider authorization seam', () => {
  it('refreshes a persisted shared Profile binding before creating Session bootstrap effects', async () => {
    await withForegroundProviderFixture({
      settings: { version: 1, profileSecretRef: 'happier:shared-secret:v1:resource-profile-shared' },
      sharedSecretRevision: 5,
    }, async (fixture) => {
      const admitted = await fixture.prepare({
        secretReferenceOverlay: { v: 1, bindings: { PROFILE_SECRET: { ref: fixture.sharedReference, revision: 4 } } },
      });
      expect(admitted).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_binding_changed', { machineId: 'machine-1', sourceProfileId: 'profile-1' }),
      });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });

  it.each([
    'reference_forbidden',
    'reference_deleted',
    'reference_mode_incompatible',
    'reference_repair_required',
    'reference_corrupt',
  ] as const)('keeps an unusable %s Profile binding a missing-secret refusal', async (reason) => {
    await withForegroundProviderFixture({
      settings: { version: 1, profileSecretRef: 'happier:shared-secret:v1:resource-profile-shared' },
      sharedSecretFailure: reason,
    }, async (fixture) => {
      expect(await fixture.prepare()).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_secret_missing', { machineId: 'machine-1', sourceProfileId: 'profile-1' }),
      });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });

  it('refreshes shared Saved Secret authorization before creating Session bootstrap effects', async () => {
    await withForegroundProviderFixture({ sharedSecretHttpStatus: 503 }, async (fixture) => {
      const admitted = await fixture.prepare({
        secretReferenceOverlay: { v: 1, bindings: { PROFILE_SECRET: { ref: fixture.sharedReference, revision: 4 } } },
      });
      expect(admitted).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_secret_unavailable', { machineId: 'machine-1', sourceProfileId: 'profile-1' }),
      });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });

  it('revalidates Provider authorization before Profile decryption and returns no environment on staleness', async () => {
    await withForegroundProviderFixture({ settings: { version: 1, corruptProfileSecret: true } }, async (fixture) => {
      const admitted = await fixture.prepare();
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      await fixture.publishSettings({
        version: 2, corruptProfileSecret: true, providerSecretValue: 'provider-plaintext-rotated', providerSecretUpdatedAt: 2,
      });
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-stale-provider', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', { connectionId: fixture.connectionId, machineId: 'machine-1' }),
      });
      expect(claimed).not.toHaveProperty('environment');
      expect(claimed).not.toHaveProperty('profileSecretRecovery');
      await admitted.prepared.cleanup();
    });
  });

  it('refuses a Provider-bound foreground admission at the feature gate before any Agent runtime bootstrap material exists', async () => {
    await withForegroundProviderFixture({ providersFeatureEnabled: false }, async (fixture) => {
      expect(await fixture.prepare()).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_feature_disabled', { connectionId: fixture.connectionId, machineId: 'machine-1' }),
      });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });

  it('refuses an orphaned previous Provider binding before foreground Agent bootstrap', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare({
        selection: undefined,
        previousBinding: {
          v: 1, connectionId: fixture.connectionId, contributionKey: fixture.contributionKey, connectionRevision: 1,
          protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'gateway',
          compatibilityFingerprint: 'compatibility:v1:one', bindingSecurityFingerprint: 'binding-security:v1:one',
          displaySnapshot: { providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
        },
      });
      expect(admitted).toEqual({
        ok: false,
        error: createProviderErrorV1('provider_binding_changed', { connectionId: fixture.connectionId, machineId: 'machine-1' }),
      });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });

  it('binds Profile scope/version through final claim and redacts successful plaintext for admission lifetime', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare({ selection: undefined });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      await fixture.publishSettings({ version: 2 });
      await expect(admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-stale-profile', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      })).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      await admitted.prepared.cleanup();
    });
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare();
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-plaintext', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed).toMatchObject({
        ok: true,
        environment: { PROFILE_SECRET: 'profile-plaintext', HAPPIER_CODEX_PROVIDER_API_KEY: 'provider-plaintext' },
        invocationContext: { cwd: fixture.directory, environment: {}, providerBindingActive: false },
        sensitiveEnvironmentVariableNames: ['PROFILE_SECRET'],
      });
      if (!claimed.ok) throw new Error(claimed.error.code);
      const handoff = consumeProviderBindingLaunchHandoffFromEnvironments([{ ...claimed.environment }]);
      expect(handoff?.materialization.kind).toBe('engineConfig');
      expect(claimed.environment).not.toHaveProperty('HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE');
      expect(claimed.environment).not.toHaveProperty('HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE');
      expect(claimed.environment).not.toHaveProperty('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE');
      expect(redactBugReportSensitiveText('value=profile-plaintext')).toBe('value=[REDACTED]');
      await admitted.prepared.cleanup();
      expect(redactBugReportSensitiveText('value=profile-plaintext')).toBe('value=profile-plaintext');
    });
  });

  it('marks the exact Profile-only launch context as having no active Provider binding', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare({ selection: undefined });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-profile-only', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed).toMatchObject({
        ok: true, invocationContext: { cwd: fixture.directory, environment: {}, providerBindingActive: false },
      });
      await admitted.prepared.cleanup();
    });
  });

  it('applies canonical Provider auth isolation before foreground Connected Account materialization', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare({
        profileId: undefined, accountSettingsScopeKey: undefined, accountSettingsVersion: undefined,
        connectedServices: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'must-be-suppressed' },
        } },
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-provider-isolated', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      expect(claimed.environment.HAPPIER_CODEX_PROVIDER_API_KEY).toBe('provider-plaintext');
      // The unsatisfied Connected Account reference would otherwise refuse;
      // actual Codex Provider requirements must suppress it before resolution.
      expect(consumeProviderBindingLaunchHandoffFromEnvironments([{ ...claimed.environment }])?.materialization.kind).toBe('engineConfig');
      await admitted.prepared.cleanup();
    });
  });

  it('relinquishes config-file cleanup to retained runner custody before ordinary generation cleanup', async () => {
    await withForegroundProviderFixture({ configFileAgent: true }, async (fixture) => {
      const admitted = await fixture.prepare();
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-retained', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      const handoff = consumeProviderBindingLaunchHandoffFromEnvironments([{ ...claimed.environment }]);
      if (handoff?.materialization.kind !== 'configFile') throw new Error('Expected physical config-file Provider handoff');
      expect(claimed.environment.PROVIDER_KEY).toBe('provider-plaintext');
      expect(JSON.parse(await readFile(join(handoff.materialization.rootPath, 'provider.json'), 'utf8'))).toEqual({ endpoint: 'https://1.1.1.1/v1' });
      claimed.authority.transferCleanupOwnership();
      await admitted.prepared.cleanup();
      expect(await stat(handoff.materialization.rootPath)).toBeDefined();
      const retainedCleanup = createProviderBindingLaunchMaterializationCleanup({
        materialization: handoff.materialization, materializationBaseDir: join(configuration.happyHomeDir, 'providers', 'materialized'),
      });
      retainedCleanup?.();
      await expect(stat(handoff.materialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('publishes exact retained-Agent source custody with managed-dependency retention', async () => {
    await withForegroundProviderFixture({ configFileAgent: true }, async (fixture) => {
      const admitted = await fixture.prepare({ selection: undefined });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-managed-retention', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      const sourceCustody = fixture.runtime.registry.readPluginSourceCustody(fixture.agentPluginId);
      expect(sourceCustody?.kind).toBe('managed');
      if (sourceCustody?.kind !== 'managed') throw new Error('Physical authored Agent source is not managed');
      expect(claimed.authority.retainedAgent.sourceCustody).toEqual(sourceCustody);
      expect(claimed.authority.runner.pid).toBe(fixture.foregroundPid);
      expect(claimed.authority.runnerManagedDependencyRetentionV1).toEqual({
        v: 1, sourceCustodies: [], qualifiedDependencyIds: [], sourceCandidates: [],
      });
      const { readAgentRuntimeDaemonServiceAuthority, readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds } =
        await import('./sessionBridgeAuthorization');
      const published = await readAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: fixture.home, publicReleaseRing: configuration.publicReleaseRing,
        path: admitted.prepared.authorization.authorityFilePath, sessionId: 'canonical-session-managed-retention',
        runner: claimed.authority.runner, retainedAgent: claimed.authority.retainedAgent,
      });
      expect(published?.retainedAgent.sourceCustody).toEqual(sourceCustody);
      expect(await readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
        happyHomeDir: fixture.home, publicReleaseRing: configuration.publicReleaseRing,
      })).toContain(sourceCustody.immutableGenerationId);
      await admitted.prepared.cleanup();
      expect(await readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
        happyHomeDir: fixture.home, publicReleaseRing: configuration.publicReleaseRing,
      })).not.toContain(sourceCustody.immutableGenerationId);
    });
  });
});
