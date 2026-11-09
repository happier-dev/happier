import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod/mini';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { createForegroundAgentRuntimeAdmissionOwner as createForegroundAdmission,
  type PreparedForegroundAgentRuntimeAdmission } from './foregroundAdmission';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createCodexForegroundConnectedAccountFixture } from './prepareForegroundAdmission.codexConnectedServices.testkit';
import { promoteForegroundDaemonServiceAuthority as promoteForegroundAuthority } from './promoteForegroundDaemonServiceAuthority';
import { readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker as readForegroundAuthority } from './sessionBridgeAuthorization';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createBuiltInQualifiedNativeRefreshHarness as createQualifiedNativeRefreshHarness } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from '../connectedServices/sessionRuntimeAuthRefresh';
import { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { writeSessionMarker } from '../sessionRegistry';

import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { spawnTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY } from './foregroundAdmissionContract';
import { claimDaemonForegroundAgentRuntimeEnvironment } from '@/agent/runtime/session/process/foregroundAgentRuntimeAdmissionClient';
import { writeDaemonState } from '@/persistence';

const claimInput = {
  canonicalSessionId: 'canonical-session-codex', httpPort: 40123,
  foregroundSatisfiedProfileSecretRequirementNames: [],
} as const;

describe('foreground Codex Connected Account lifecycle through real materialization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refreshes promoted foreground Sessions and retires exact authority without deleting their shared Account home', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    let account!: Awaited<ReturnType<typeof createQualifiedNativeRefreshHarness>>;
    await withRealForegroundAdmissionFixture({
      async createRuntime({ home, controller }) {
        account = await createQualifiedNativeRefreshHarness({ happyHomeDir: home, controller, runtimeRegistry: registry });
        return account.admittedRuntime;
      },
    }, async (fixture) => {
      const trackedSessions = new Map<number, TrackedSession>();
      const preparedBySession = new Map<string, PreparedForegroundAgentRuntimeAdmission>();
      const authorityBySession = new Map<string, NonNullable<Awaited<ReturnType<typeof readForegroundAuthority>>>>();
      let connectedServicePreparationError: unknown;
      const connectedServices = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      } };
      const admission = createForegroundAdmission({
        connectedServiceRuntimeRegistry: registry,
        prepare: async (request) => {
          const result = await fixture.prepare({ connectedServices, sessionId: request.sessionId,
            attemptId: request.attemptId, foregroundPid: request.foregroundPid }, {
          activateSessionPurposeBindings: account.purposeRuntime.activateSessionPurposeBindings,
          activatePurposeBindings: account.purposeRuntime.activatePurposeBindings,
          connectedServicesMaterializationBaseDir: join(account.happyHomeDir, 'materialized'),
          resolveConnectedServiceAuthForSpawn: async (input) => {
            try { return await resolveConnectedServiceAuthForSpawn({
            ...input, credentials: account.credentials, api: account.api,
            qualifiedConnectedAccountApi: account.qualifiedApi,
            credentialRefreshService: account.coordinator,
            activeServerDir: join(account.happyHomeDir, 'active'), baseDir: join(account.happyHomeDir, 'materialized'),
            }); } catch (error) { connectedServicePreparationError = error; throw error; }
          },
          resolveDaemonSpawnHooks: async (agentId) => {
            const entry = await fixture.runtime.registry.acquireAgentCatalogEntry?.(agentId);
            return await entry?.getDaemonSpawnHooks?.() ?? null;
          },
          });
          if (result.ok) preparedBySession.set(request.sessionId, result.prepared);
          return result;
        },
        getHttpPort: () => 40123,
        async promoteDaemonServiceAuthority(input) {
          const tracked: TrackedSession = { pid: input.foregroundPid, startedBy: 'terminal',
            happySessionId: input.canonicalSessionId, processStartTimeMs: input.runner.processStartTimeMs,
            processCommandHash: input.runner.processCommandHash };
          trackedSessions.set(input.foregroundPid, tracked);
          const markerTime = Date.now();
          await writeSessionMarker({ pid: input.foregroundPid, startedBy: 'terminal',
            happySessionId: input.canonicalSessionId,
            createdAt: markerTime, updatedAt: markerTime, processStartTimeMs: input.runner.processStartTimeMs,
            processCommandHash: input.runner.processCommandHash });
          const promoted = await promoteForegroundAuthority({ ...input, trackedSessions, happyHomeDir: fixture.home,
            publicReleaseRing: configuration.publicReleaseRing });
          if (promoted) {
            const authority = await readForegroundAuthority({ happyHomeDir: fixture.home,
              publicReleaseRing: configuration.publicReleaseRing, path: input.authorityFilePath,
              sessionId: input.canonicalSessionId, runner: input.runner });
            if (!authority) throw new Error('Promoted foreground authority failed real verification');
            authorityBySession.set(input.canonicalSessionId, authority);
          }
          return promoted;
        },
      });
      let secondForeground: ReturnType<typeof spawnTestProcess> | null = null;
      try {
        const claim = async (sessionId: string, foregroundPid: number, attemptId: string, provisionalSessionId = sessionId) => {
          const admitted = await admission.admit(fixture.request({ connectedServices, sessionId: provisionalSessionId, foregroundPid, attemptId }));
          expect(admitted.ok, admitted.ok ? undefined : `${admitted.error.code}; ${String(connectedServicePreparationError)}`).toBe(true);
          if (!admitted.ok) throw new Error(admitted.error.code);
          const descriptor = admitted.capability.descriptor;
          const capability = z.looseObject({ capability: z.string() }).parse(
            JSON.parse(await readFile(admitted.capability.admissionFilePath, 'utf8')),
          ).capability;
          const claimed = await admission.claimEnvironment({ v: 1, attemptId,
            provisionalSessionId, canonicalSessionId: sessionId,
            foregroundPid, pluginId: descriptor.pluginId, agentId: descriptor.agentId,
            occurrenceId: descriptor.occurrenceId, sourceCustody: descriptor.sourceCustody, capability,
            ...(admitted.launchPolicy.nativeHomeSourceEnvironmentKey
              ? { nativeHomeSourceEnvironmentValue: process.env[admitted.launchPolicy.nativeHomeSourceEnvironmentKey] ?? null }
              : {}),
            foregroundSatisfiedProfileSecretRequirementNames: [] });
          expect(claimed.ok, claimed.ok ? undefined : claimed.error.code).toBe(true);
          if (!claimed.ok) throw new Error(claimed.error.code);
          // Real materialization and the foreground claim must carry the same
          // admitted Account into native open, not only credential-bearing env.
          writeDaemonState({ pid: foregroundPid, httpPort: 40123, controlToken: 'synthetic-control',
            startedAt: Date.now(), startedWithCliVersion: 'fixture' });
          // Only the daemon HTTP response is replaced: the real private handoff,
          // control client and foreground startup reader consume the owner result.
          const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(claimed), { status: 200 }));
          try {
            expect(await claimDaemonForegroundAgentRuntimeEnvironment({
              env: { [HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY]: admitted.capability.admissionFilePath },
              provisionalSessionId, canonicalSessionId: sessionId, attemptId, foregroundPid,
              foregroundSatisfiedProfileSecretRequirementNames: [],
              ...(admitted.launchPolicy.nativeHomeSourceEnvironmentKey
                ? { nativeHomeSourceEnvironmentValue: process.env[admitted.launchPolicy.nativeHomeSourceEnvironmentKey] ?? null }
                : {}),
            })).toMatchObject({ sessionConnectedAccounts: [{ purpose: 'primary', account: account.account }] });
          } finally {
            transport.mockRestore();
          }
          return claimed;
        };
        const provisionalSessionId = 'provisional-session-codex';
        const claimed = await claim(claimInput.canonicalSessionId, fixture.foregroundPid, 'attempt-1', provisionalSessionId);
        expect(registry.getBySessionId(claimInput.canonicalSessionId)).toMatchObject({
          pid: fixture.foregroundPid, agentId: 'codex',
          materializationKey: provisionalSessionId,
          exactPurposeBindingSubjectId: `agent-session:${claimInput.canonicalSessionId}`,
        });
        secondForeground = spawnTestProcess(process.execPath, [fixture.foregroundEntrypoint]);
        await once(secondForeground, 'spawn');
        if (!secondForeground.pid) throw new Error('Second real foreground process unavailable');
        const secondSessionId = 'canonical-session-codex-other';
        const secondClaim = await claim(secondSessionId, secondForeground.pid, 'attempt-2');
        const secondNativeHome = secondClaim.environment.CODEX_HOME;
        if (!secondNativeHome) throw new Error('Second promoted native home unavailable');
        const nativeHome = claimed.environment.CODEX_HOME;
        if (!nativeHome) throw new Error('Promoted native home unavailable');
        expect(secondNativeHome).toBe(nativeHome);
        const tracked = trackedSessions.get(fixture.foregroundPid);
        expect(tracked?.agentRuntimeDaemonServiceAuthorityFilePath).toBeTruthy();
        const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
        const exactPurpose = { purpose, serviceRefs: [account.service],
          exactPurposeBindingSubjectId: `agent-session:${claimInput.canonicalSessionId}`,
          sessionId: claimInput.canonicalSessionId, signal: new AbortController().signal };
        await expect(account.purposeRuntime.owner.getBinding(exactPurpose)).resolves.toMatchObject({ account: account.account });
        const secondExactPurpose = { ...exactPurpose, sessionId: secondSessionId,
          exactPurposeBindingSubjectId: `agent-session:${secondSessionId}` };
        await expect(account.purposeRuntime.owner.getBinding(secondExactPurpose)).resolves.toMatchObject({ account: account.account });
        await expect(stat(secondNativeHome)).resolves.toBeTruthy();
        await expect(stat(nativeHome)).resolves.toBeTruthy();
        const restartRequests: string[] = [];
        account.purposeRuntime.bindSessionRestartOwner(({ sessionId }) => restartRequests.push(sessionId));
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
          access_token: 'access-fresh', refresh_token: 'refresh-fresh', id_token: 'id-fresh', expires_in: 3600,
        }), { status: 200 }));
        const authority = authorityBySession.get(claimInput.canonicalSessionId);
        const prepared = preparedBySession.get(provisionalSessionId);
        if (!authority || !prepared) throw new Error('Actual promoted native auth source is unavailable');
        const refresh = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry,
          captureSessionAuthority: () => ({ identity: authority, isCurrent: () => prepared.isCurrent()
            && fixture.runtime.controller.isRuntimeRegistryCurrent(fixture.runtime.registry)
            && trackedSessions.get(fixture.foregroundPid) === tracked }),
          resolveDaemonAuthBridge: async (serviceId) => ({ serviceId, async refresh(request, context) {
            if (!context || !request.expectedCredentialRevision || !request.refreshAttemptId) {
              return { status: 'unavailable', reason: 'missing_authority' };
            }
            return await account.coordinator.refreshConnectedServiceCredentialForRuntimeAuthBridge({
              target: context.target, authority: context.authority, isCurrent: context.isCurrent,
              acceptSettledCredentialRevision: context.acceptSettledCredentialRevision,
              serviceId, profileId: 'work', expectedCredentialRevision: request.expectedCredentialRevision,
              refreshAttemptId: request.refreshAttemptId,
            });
          } }),
        });
        await expect(refresh({ sessionId: claimInput.canonicalSessionId,
          selection: { kind: 'profile', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work' },
          expectedCredentialRevision: account.firstRevision, refreshAttemptId: 'native-own-refresh',
        })).resolves.toMatchObject({ ok: true, result: { status: 'refreshed', result: { credentialRevision: account.secondRevision } } });
        // Real resolution/materialization must reread the rotated credential while
        // preserving the already-promoted launch's exact subject and resources.
        let materializedRevision: string | null = null;
        const fresh = await account.purposeRuntime.owner.materialize({ ...exactPurpose,
          expectedAccount: account.account,
          credentialRevisionBasis: { expectedCredentialRevision: account.secondRevision,
            captureCredentialRevision: revision => { materializedRevision = revision; } },
          request: { kind: 'files', fileIds: ['auth.json'] } });
        expect(materializedRevision).toBe(account.secondRevision);
        expect(fresh.kind).toBe('files');
        if (fresh.kind !== 'files') throw new Error('Fresh native auth is not files');
        expect(JSON.parse(new TextDecoder().decode(fresh.files['auth.json']))).toMatchObject({
          access_token: 'access-fresh', refresh_token: '', tokens: { access_token: 'access-fresh', refresh_token: '' },
        });
        await expect(stat(nativeHome)).resolves.toBeTruthy();
        expect(restartRequests).not.toContain(claimInput.canonicalSessionId);
        expect(tracked?.agentRuntimeDaemonServiceAuthorityFilePath).toBeTruthy();
        // Distribution rematerializes both registered Sessions, rather than
        // invalidating unrelated exact purpose leases through a global callback.
        expect(registry.getBySessionId(secondSessionId)).toMatchObject({ pid: secondForeground.pid });
        await expect(account.purposeRuntime.owner.getBinding(secondExactPurpose)).resolves.toMatchObject({ account: account.account });
        expect(JSON.parse(await readFile(join(secondNativeHome, 'auth.json'), 'utf8'))).toMatchObject({ access_token: 'access-fresh' });
        await admission.releaseSession(secondSessionId);
        expect(registry.getBySessionId(secondSessionId)).toBeNull();
        await expect(account.purposeRuntime.owner.getBinding(secondExactPurpose)).resolves.toBeNull();
        await expect(account.purposeRuntime.owner.materialize({ ...secondExactPurpose,
          request: { kind: 'files', fileIds: ['auth.json'] },
        })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
        await expect(stat(secondNativeHome)).resolves.toBeTruthy();
        expect(registry.getBySessionId(claimInput.canonicalSessionId)).not.toBeNull();
        await expect(account.purposeRuntime.owner.getBinding(exactPurpose)).resolves.toMatchObject({ account: account.account });
        await admission.releaseSession(claimInput.canonicalSessionId);
        expect(registry.getBySessionId(claimInput.canonicalSessionId)).toBeNull();
        await expect(account.purposeRuntime.owner.getBinding(exactPurpose)).resolves.toBeNull();
        await expect(account.purposeRuntime.owner.materialize({ ...exactPurpose,
          request: { kind: 'files', fileIds: ['auth.json'] },
        })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
        await expect(stat(nativeHome)).resolves.toBeTruthy();
        expect(JSON.parse(await readFile(join(nativeHome, 'auth.json'), 'utf8'))).toMatchObject({ access_token: 'access-fresh' });
      } finally {
        try { await admission.dispose(); }
        finally {
          if (secondForeground?.pid) {
            secondForeground.kill();
            expect(await waitForProcessExit(secondForeground.pid)).toBe(true);
          }
        }
      }
    });
  });

  it('binds the native Account purpose to the exact claimed Session and retains its Account home after Session cleanup', async () => {
    const account = await createCodexForegroundConnectedAccountFixture();
    try {
      await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async (fixture) => {
        const admitted = await fixture.prepare({ connectedServices: account.connectedServices }, await account.dependenciesFor(fixture.runtime.registry, fixture.directory));
        expect(admitted.ok, admitted.ok ? undefined : `${admitted.error.code}; materializations=${account.materializations.length}`).toBe(true);
        if (!admitted.ok) throw new Error(admitted.error.code);
        const materialized = account.materializations[0];
        if (!materialized) throw new Error('Real Codex materialization was not prepared');
        const operationSubjectId = materialized.materializationPurposeLease?.subjectId;
        if (!operationSubjectId) throw new Error('Foreground materialization has no exact purpose authority');
        const operationBinding = {
          purpose: account.purpose, serviceRefs: [account.service],
          exactPurposeBindingSubjectId: operationSubjectId,
          signal: new AbortController().signal,
        };
        await expect(account.owner.getBinding(operationBinding)).resolves.toMatchObject({
          account: { service: account.service, accountId: 'work' },
        });
        const nativeHome = materialized.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY];
        if (!nativeHome) throw new Error('Codex materializer did not publish native-home custody');
        const nativeAuth = await readFile(join(nativeHome, 'auth.json'), 'utf8');
        // Native Codex receives the selected Account's access proof, while the
        // Connected Account owner retains refresh/rotation authority.
        expect(JSON.parse(nativeAuth)).toMatchObject({
          auth_mode: 'chatgptAuthTokens', OPENAI_API_KEY: null,
          access_token: 'work-access', refresh_token: '', id_token: 'work-id', account_id: 'work-account',
          tokens: { access_token: 'work-access', refresh_token: '', id_token: 'work-id', account_id: 'work-account' },
        });
        expect(nativeAuth).not.toContain('work-refresh');
        const exactSessionBinding = {
          purpose: account.purpose, serviceRefs: [account.service],
          exactPurposeBindingSubjectId: `agent-session:${claimInput.canonicalSessionId}`,
          sessionId: claimInput.canonicalSessionId, signal: new AbortController().signal,
        };
        await expect(account.owner.getBinding(exactSessionBinding)).resolves.toBeNull();
        const claimed = await admitted.prepared.claim(claimInput);
        expect(claimed.ok, claimed.ok ? undefined : `native Account claim: ${claimed.error.code}`).toBe(true);
        if (!claimed.ok) throw new Error(claimed.error.code);
        expect(claimed.environment.CODEX_HOME).toBe(nativeHome);
        await expect(readFile(join(nativeHome, 'auth.json'), 'utf8')).resolves.toBe(nativeAuth);
        await expect(account.owner.getBinding(exactSessionBinding)).resolves.toMatchObject({
          purpose: 'primary', service: account.service,
          account: { service: account.service, accountId: 'work' },
        });
        // The real Codex launch consumes native auth.json, not an HTTP bearer
        // capability. External Agent keepers exercise that distinct transport.
        expect(claimed.environment).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');
        expect(materialized.requestAuthPurposeBindings).toEqual([]);
        await admitted.prepared.cleanup();
        await expect(account.owner.getBinding(operationBinding)).resolves.toBeNull();
        await expect(account.owner.getBinding(exactSessionBinding)).resolves.toBeNull();
        await expect(account.owner.materialize({ ...exactSessionBinding,
          request: { kind: 'files', fileIds: ['auth.json'] },
        })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
        await expect(readFile(join(nativeHome, 'auth.json'), 'utf8')).resolves.toBe(nativeAuth);
      });
    } finally {
      await account.cleanup();
    }
  });

  it('retires a failed foreground claim and its bootstrap files without deleting the Account home', async () => {
    const account = await createCodexForegroundConnectedAccountFixture();
    try {
      await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async (fixture) => {
        const dependencies = await account.dependenciesFor(fixture.runtime.registry, fixture.directory);
        const admission = createForegroundAdmission({
          prepare: request => fixture.prepare({ connectedServices: account.connectedServices,
            sessionId: request.sessionId, attemptId: request.attemptId, foregroundPid: request.foregroundPid,
          }, dependencies),
          getHttpPort: () => claimInput.httpPort,
        });
        try {
          const request = fixture.request({ connectedServices: account.connectedServices });
          const admitted = await admission.admit(request);
          expect(admitted.ok, admitted.ok ? undefined : `${admitted.error.code}; materializations=${account.materializations.length}`).toBe(true);
          if (!admitted.ok) throw new Error(admitted.error.code);
          const nativeHome = account.materializations[0]?.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY];
          if (!nativeHome) throw new Error('Prepared Codex native home is unavailable');
          await expect(stat(nativeHome)).resolves.toBeTruthy();
          await expect(stat(admitted.capability.admissionFilePath)).resolves.toBeTruthy();
          await expect(stat(admitted.capability.bootstrapFilePath)).resolves.toBeTruthy();
          const capability = z.looseObject({ capability: z.string() }).parse(
            JSON.parse(await readFile(admitted.capability.admissionFilePath, 'utf8')),
          ).capability;
          const descriptor = admitted.capability.descriptor;
          const claimRequest = { v: 1, attemptId: request.attemptId,
            provisionalSessionId: request.sessionId, canonicalSessionId: claimInput.canonicalSessionId,
            foregroundPid: request.foregroundPid, pluginId: descriptor.pluginId, agentId: descriptor.agentId,
            occurrenceId: descriptor.occurrenceId, sourceCustody: descriptor.sourceCustody, capability,
            ...(admitted.launchPolicy.nativeHomeSourceEnvironmentKey
              ? { nativeHomeSourceEnvironmentValue: process.env[admitted.launchPolicy.nativeHomeSourceEnvironmentKey] ?? null }
              : {}),
            foregroundSatisfiedProfileSecretRequirementNames: [],
          } satisfies Parameters<typeof admission.claimEnvironment>[0];
          const expectClaimRefused = async () => {
            const claimed = await admission.claimEnvironment(claimRequest).catch((error: unknown) => {
              // The existing liveness owner may have retired this exact attempt
              // already; accept only its specific unavailable refusal.
              if (error instanceof Error && error.message === 'Foreground Agent runtime admission is unavailable') return null;
              throw error;
            });
            if (claimed !== null) expect(claimed).toMatchObject({
              ok: false, error: { code: 'provider_agent_runtime_unsupported' },
            });
          };
          process.kill(fixture.foregroundPid);
          expect(await waitForProcessExit(fixture.foregroundPid)).toBe(true);
          await expectClaimRefused();
          await expect(stat(admitted.capability.admissionFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(stat(admitted.capability.bootstrapFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expectClaimRefused();
          await expect(stat(nativeHome)).resolves.toBeTruthy();
        } finally {
          await admission.dispose();
        }
      });
    } finally {
      await account.cleanup();
    }
  });

});
