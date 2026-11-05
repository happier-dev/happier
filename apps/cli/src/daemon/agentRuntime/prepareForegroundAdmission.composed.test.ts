import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { createProviderErrorV1, redactBugReportSensitiveText, ProviderBoundModelRefSchema, projectAgentSessionProviderBindingV1 } from '@happier-dev/protocol';

import { createAgentRuntimeDaemonServiceAuthorityFixture as createTestAuthority } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthority.testkit';
import { authorizeCurrentAgentRuntimeDaemonModelTransition } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createSessionModelTransitionAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { createSessionModelTransitionCoordinator, type AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { configuration } from '@/configuration';
import { consumeProviderBindingLaunchHandoffFromEnvironments } from '@/plugins/runtime/providerBindings/handoff';
import { createProviderBindingLaunchMaterializationCleanup } from '@/providers/spawn/compose';
import { withForegroundProviderFixture } from './prepareForegroundAdmission.providers.testkit';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { readStoredCredentials } from '@/persistence';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';

afterEach(() => vi.restoreAllMocks());

describe('foreground admission composed real Provider authorization seam', () => {
  it('refuses a destination Profile changed without a Settings revision before final claim', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const record = ProfileRecordV1Schema.parse({ v: 1, id: 'profile-1', enabled: true,
        definition: { kind: 'inline', profile: { v: 2, id: 'profile-1', name: 'Profile', createdAt: 1, updatedAt: 1,
          envVarRequirements: [{ name: 'PROFILE_SECRET', kind: 'secret', required: true }] } },
        promptStack: [], secretBindings: { PROFILE_SECRET: fixture.sharedReference },
      });
      fixture.publishProfileRecord(record, 1);
      const credentials = await readStoredCredentials();
      if (!credentials) throw new Error('Physical foreground credentials unavailable');
      expect(await refreshActiveProfileCatalog({ credentials })).toMatchObject({ status: 'ready', source: 'destination' });
      expect(fixture.runtime.registry.contributes.agentDefinitionsById.get(fixture.agentId))
        .toMatchObject({ id: fixture.agentId, pluginId: fixture.agentPluginId });
      const settingsVersion = getActiveAccountSettingsSnapshot()?.settingsVersion;
      const admitted = await fixture.prepare({ selection: undefined, profileRecordRevision: 1 });
      expect(admitted).toMatchObject({ ok: true });
      if (!admitted.ok) throw new Error(admitted.error.code);
      fixture.publishProfileRecord(record, 2);
      // Observe the Home's changed row through the real catalog reader; the
      // HTTP fixture does not publish the Account change carrier itself.
      expect(await refreshActiveProfileCatalog({ credentials })).toMatchObject({ status: 'ready', source: 'destination' });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(settingsVersion);
      await expect(admitted.prepared.claim({ canonicalSessionId: 'canonical-session-stale-profile-row', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      })).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      await admitted.prepared.cleanup();
    });
  });

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
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
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

  it('binds Profile scope/version through final claim', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const admitted = await fixture.prepare({ selection: undefined });
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      await fixture.publishSettings({ version: 2 });
      await expect(admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-stale-profile', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      })).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      await admitted.prepared.cleanup();
    });
  });

  it.each([
    { providerSecretMode: 'plain' as const, requesterCustody: false },
    { providerSecretMode: 'e2ee' as const, requesterCustody: false },
    { providerSecretMode: 'e2ee' as const, requesterCustody: true },
  ])('claims the real Codex binding from a $providerSecretMode Saved Secret with requester custody $requesterCustody', async options => {
    await withForegroundProviderFixture(options, async (fixture) => {
      const admitted = await fixture.prepare();
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: options.requesterCustody ? 'session-1' : 'canonical-session-plaintext', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok, !claimed.ok ? JSON.stringify(claimed.error) : undefined).toBe(true);
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
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-profile-only', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok, !claimed.ok ? JSON.stringify(claimed.error) : undefined).toBe(true);
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
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
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
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
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
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-managed-retention', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      if (!fixture.runtime.registry.readPluginSourceCustody) throw new Error('Expected admitted runtime source custody reader');
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

  it.each([
    { model: 'same', confirmed: false }, { model: 'same', confirmed: true },
    { model: 'different', confirmed: false }, { model: 'different', confirmed: true },
  ] as const)('reconciles an admitted Provider metadata selection without another secret acquisition ($model model, confirmed $confirmed)', async ({ model, confirmed }) => {
    await withForegroundProviderFixture({}, async fixture => {
      const admitted = await fixture.prepare({ profileId: undefined });
      if (!admitted.ok) throw new Error(admitted.error.code);
      try {
        const claimed = await admitted.prepared.claim({ canonicalSessionId: 'session-1', httpPort: 40123,
          foregroundSatisfiedProfileSecretRequirementNames: [] });
        if (!claimed.ok) throw new Error(claimed.error.code);
        const handoff = consumeProviderBindingLaunchHandoffFromEnvironments([{ ...claimed.environment }]);
        if (!handoff?.sessionBindingMetadata.runtimeBindingBasis) throw new Error('Expected an admitted Provider binding');
        const metadata = handoff.sessionBindingMetadata;
        const basis = metadata.runtimeBindingBasis!;
        const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey: basis.agentTargetKey,
          providerConnectionId: metadata.connectionId, modelId: metadata.model.id });
        const baseAuthority = await createTestAuthority({ happyHomeDir: fixture.home, runner: {
          pid: 1234, processStartTimeMs: 1_717_171_717_000,
          processCommandHash: 'a'.repeat(64), snapshotIdentity: 'snapshot:runner-a',
        } });
        const authority = { ...baseAuthority, retainedAgent: createAgentSessionRunnerFactoryBinding({
          ...baseAuthority.retainedAgent, pluginId: 'happier.agent.codex', agentId: 'codex', localAgentId: 'codex',
        }) };
        // The daemon HTTP boundary refuses fresh acquisition; the claimed binding,
        // coordinator, authorizer, authority reader and response decoder stay real.
        const requests: string[] = [];
        const server = createServer((request, response) => {
          requests.push(request.url ?? '');
          request.resume();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false,
            error: { code: 'provider_secret_missing', message: 'provider_secret_missing' } }));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a daemon HTTP fixture port');
        await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
        const initialTarget: AuthorizedSessionModelTransitionTarget = {
          selection, policy: 'live', sessionBindingMetadata: metadata, runtimeBindingBasis: basis,
          providerBinding: projectAgentSessionProviderBindingV1({ metadata, materialization: handoff.materialization }),
          revalidateBeforeEffect: async () => true,
        };
        let coordinator: ReturnType<typeof createSessionModelTransitionCoordinator> | undefined;
        const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
          agentId: 'codex', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
          readActiveTarget: () => coordinator?.readActiveTarget() ?? initialTarget,
          authorizeProviderTarget: (input, signal) => authorizeCurrentAgentRuntimeDaemonModelTransition({
            authority, requestId: 'metadata-reconciliation', selection: input.selection, signal, timeoutMs: null }),
        });
        const effects: string[] = [];
        coordinator = createSessionModelTransitionCoordinator({ runId: 'run-1', agentTargetKey: selection.agentTargetKey,
          initialActiveTarget: initialTarget, initialActiveTargetConfirmed: confirmed,
          readModelSelectionIntent: () => null, isCurrentRun: () => true, checkCurrentPublisherAuthority: async () => true,
          authorize, publishIntent: async () => { effects.push('intent'); return { accepted: true, updatedAt: 1 }; },
          applyRuntime: async () => { effects.push('runtime'); return { status: 'applied' }; },
          publishActive: async () => { effects.push('active'); }, revokeActiveSelectionProof: async () => {},
          fencePromptAdmission: async () => {}, clearPromptAdmission: async () => {},
          transferPromptAdmission: async (_epoch, input) => { await input.dispatch(); return { status: 'dispatched', value: undefined }; },
        });
        try {
          const requested = model === 'same' ? selection : { ...selection, modelId: 'different-model' };
          const result = await coordinator.submit(requested, { source: 'metadata', reuseInitialAdmission: true });
          expect(result).toMatchObject(model === 'same'
            ? { ok: true, status: confirmed ? 'already_active' : 'armed', activeSelection: selection }
            : { ok: false, reason: 'provider_secret_missing' });
          expect(requests).toHaveLength(model === 'same' ? 0 : 1);
          expect(effects).toEqual([]);
          expect(coordinator.readActiveTarget()).toEqual(initialTarget);
          expect(await coordinator.readAppliedTarget()).toEqual(confirmed
            ? { status: 'applied', target: initialTarget }
            : { status: 'unavailable', reason: 'runtime_model_unconfirmed' });
        } finally {
          await coordinator.dispose();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      } finally { await admitted.prepared.cleanup(); }
    });
  });
});
