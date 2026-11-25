import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { lstatSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
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
import axios from 'axios';
import { ApiClient } from '@/api/api';
import { executeSpawnSessionRequest } from '@/daemon/startup/executeSpawnSessionRequest';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { FOREGROUND_AGENT_RUNTIME_CLAIM_PATH, ForegroundAgentRuntimeAdmissionResponseV1Schema, ForegroundAgentRuntimeClaimResponseV1Schema } from './foregroundAdmissionContract';
import { createForegroundAdmissionError } from '@/cli/foregroundAdmissionFailure';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';
import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import { createForegroundAgentRuntimeAdmissionOwner } from './foregroundAdmission';
import { createDaemonControlApp } from '../controlServer';
import { admitDaemonForegroundAgentRuntime } from '../controlClient';
import { resolveAgentIsolationMemberCliRuntime } from '@/daemon/agentIsolation/memberCliRuntime';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readLinuxProcFile } from '@/processes/census/linuxProcfs';
import { resolveDaemonTerminalLaunch } from '@/terminal/pty/launch';
import * as processIdentity from '../processIdentity';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), readlinkSync: vi.fn(fs.readlinkSync) };
});

const memberCli = resolveAgentIsolationMemberCliRuntime('/fixture/install/cli/current/happier');
const memberCliGeneration = 'a'.repeat(64);
const immutableMemberCli = join(memberCli.root, memberCliGeneration, 'happier');
const memberRequester = {
  serverId: 'fixture-member-home', machineId: 'machine-1', installationId: 'fixture-installation', accountId: 'fixture-member',
};

async function simulatePublishedMemberCli(installed = true) {
  const { lstatSync: stat, readlinkSync: link } = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation((path, options) => {
    if (path === '/' || path === '/opt' || path === memberCli.root || path === dirname(immutableMemberCli)) {
      return Object.assign(stat('/'), { uid: 0, mode: 0o40755 });
    }
    if (path === immutableMemberCli && installed) {
      return Object.assign(stat(process.execPath), { uid: 0, mode: 0o100755 });
    }
    return stat(path, options);
  });
  vi.mocked(readlinkSync).mockImplementation((path, options) =>
    path === dirname(memberCli.executable) ? memberCliGeneration : link(path, options));
  return () => {
    vi.mocked(lstatSync).mockImplementation(stat);
    vi.mocked(readlinkSync).mockImplementation(link);
  };
}

function readMemberCliProcess(pid: number, file: string, args: readonly string[]) {
  return processIdentity.readProcessIdentityByPid(pid, { linuxBoundary: {
    readdir, readlink,
    readFile: (path, encoding) => path === `/proc/${pid}/cmdline`
      ? Promise.resolve([file, ...args, ''].join('\0'))
      : readLinuxProcFile(path, encoding),
  } });
}

function launchMemberCli() {
  return resolveDaemonTerminalLaunch({ kind: 'happier_cli', args: ['codex'] }, {
    memberLaunch: {
      memberIdentity: { ...deriveAgentIsolationMemberIdentity({ requester: memberRequester, homeServerIdentityId: 'fixture-member-home' }),
        agentUid: 41001, agentGid: 41001 },
      managedHappierBinaryPath: memberCli.executable,
      runtimeHome: '/member/runtime',
      homeApplicationUrl: 'https://member-home.example.test',
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('foreground admission composed real Provider authorization seam', () => {
  it.skipIf(process.platform !== 'linux')('identifies the installed generation from the member terminal argv read by Linux census', async () => {
    const restore = await simulatePublishedMemberCli();
    try {
      const launch = await launchMemberCli();
      const launched = await readMemberCliProcess(process.pid, launch.file, launch.args);
      expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(launched?.command))
        .toMatchObject({ status: 'known', comparableId: `version:${memberCliGeneration}` });
      expect(launch).toEqual({
        file: memberCli.executable, args: ['--server-url', 'https://member-home.example.test', 'codex'],
      });
    } finally {
      restore();
    }
  });

  it.skipIf(process.platform !== 'linux').each(['installed pointer', 'non-installed pointer', 'unknown'] as const)(
    'checks the %s member process identity during foreground claim', async entrypoint => {
      await withForegroundProviderFixture({ configFileAgent: true }, async fixture => {
        const request = fixture.request({ selection: undefined });
        const owner = createForegroundAgentRuntimeAdmissionOwner({
          prepare: (input, signal) => fixture.prepare(input, { signal }),
          getHttpPort: () => 43127,
        });
        const app = createDaemonControlApp({
          machineId: request.machineId, controlToken: 'control-token', foregroundAgentRuntimeAdmission: owner,
          getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
          spawnSession: async () => { throw new Error('Foreground control must not spawn a Session'); },
          requestShutdown: () => undefined, onHappySessionWebhook: () => undefined,
        });
        const restore = await simulatePublishedMemberCli(entrypoint !== 'non-installed pointer');
        try {
          const admitted = await owner.admit(request);
          if (!admitted.ok) throw new Error(admitted.error.code);
          const launch = await launchMemberCli();
          const observed = await readMemberCliProcess(fixture.foregroundPid,
            entrypoint === 'unknown' ? '/usr/bin/unrecognized' : launch.file, launch.args);
          expect(observed?.pid).toBe(fixture.foregroundPid);
          const readProcess = processIdentity.readProcessIdentityByPid;
          const processBoundary = vi.spyOn(processIdentity, 'readProcessIdentityByPid')
            .mockImplementation((pid, deps) => pid === fixture.foregroundPid ? Promise.resolve(observed) : readProcess(pid, deps));
          try {
            const { descriptor, admissionFilePath } = admitted.capability;
            const { capability } = JSON.parse(await readFile(admissionFilePath, 'utf8'));
            const canonicalSessionId = 'canonical-member-session';
            const claim = await app.inject({
              method: 'POST', url: FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
              headers: { 'x-happier-daemon-token': capability },
              payload: {
                v: 1, attemptId: request.attemptId, provisionalSessionId: request.sessionId,
                canonicalSessionId, foregroundPid: fixture.foregroundPid, capability,
                pluginId: descriptor.pluginId, agentId: descriptor.agentId,
                occurrenceId: descriptor.occurrenceId, sourceCustody: descriptor.sourceCustody,
                foregroundSatisfiedProfileSecretRequirementNames: [],
              },
            });
            expect(claim.statusCode, claim.body).toBe(200);
            const response = ForegroundAgentRuntimeClaimResponseV1Schema.parse(claim.json());
            if (entrypoint === 'installed pointer') {
              expect(response).toMatchObject({ ok: true });
              expect(owner.isSessionCurrent(canonicalSessionId)).toBe(true);
            } else {
              expect(response).toMatchObject({ ok: false, error: {
                code: 'runner_entrypoint_unavailable', failureCause: { phase: 'foreground.claim' },
              } });
              expect(owner.isSessionCurrent(canonicalSessionId)).toBe(false);
              if (response.ok) throw new Error('Expected a foreground claim refusal');
              const presentation = presentProviderCliRefusal(response.error).join('\n');
              expect(presentation).toContain('could not verify the foreground runner executable');
              expect(presentation).not.toContain('Provider binding');
            }
          } finally {
            processBoundary.mockRestore();
          }
        } finally {
          restore();
          await owner.dispose();
          await app.close();
        }
      });
    },
  );

  it('preserves the selected Profile refusal in runner and terminal output', async () => {
    await withForegroundProviderFixture({}, async fixture => {
      const response = ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(
        await fixture.prepare({ profileId: 'missing-profile' }),
      );
      expect(response).toMatchObject({ ok: false, error: {
        code: 'provider_agent_runtime_unsupported',
        failureCause: { phase: 'foreground.profile_selection' },
      } });
      if (response.ok || !('v' in response.error)) throw new Error('Expected a Provider refusal');
      expect(createForegroundAdmissionError(response.error).message).toContain('foreground.profile_selection');
      expect(presentProviderCliRefusal(response.error).join('\n')).toContain('foreground.profile_selection');
    });
  });

  it('carries only the safe exception class and code when bootstrap storage fails', async () => {
    await withForegroundProviderFixture({}, async fixture => {
      const tmp = join(fixture.home, 'tmp');
      const blockedDirectory = join(tmp, resolveReleaseRingScopedBasename(
        'foreground-agent-runtime-bootstraps', configuration.publicReleaseRing,
      ));
      await mkdir(tmp, { recursive: true });
      await writeFile(blockedDirectory, 'A file blocks creation of this directory');
      const response = ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(
        await fixture.prepare({ profileId: undefined, selection: undefined }),
      );
      expect(response).toMatchObject({ ok: false, error: {
        code: 'provider_agent_runtime_unsupported',
        failureCause: { phase: 'foreground.admission', errorClass: 'Error', errorCode: null },
      } });
      expect(JSON.stringify(response)).not.toContain(fixture.home);
    });
  });

  it.each(['directly', 'sandbox'] as const)('preserves native fork locality under %s Session policy', async kind => {
    await withForegroundProviderFixture({}, async fixture => {
      const result = await fixture.prepare({ profileId: undefined, nativeFork: true }, {
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {
          isolationPolicyV1: { configuredSandboxes: { local: {
            provisioner: { pluginId: 'acme.sandbox', localId: 'sandbox' }, presetId: 'preset' } }, workKinds: {
            sessions: kind === 'directly' ? { kind: 'directly' } : { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
            botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' },
          } },
        } }),
      });
      if (kind === 'directly') {
        expect(result).toMatchObject({ ok: true });
      } else {
        const response = ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(result);
        expect(response).toMatchObject({ ok: false, error: { kind: 'launch_error', code: 'target_unavailable' } });
        expect(response).not.toHaveProperty('sessionSpawnRequired');
        expect(await fixture.bootstrapFiles()).toEqual([]);
      }
    });
  });
  it('hands a new policy-Machine start to session.spawn_new before issuing local Agent authority', async () => {
    await withForegroundProviderFixture({}, async fixture => {
      const result = await fixture.prepare({ profileId: undefined }, {
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {
          isolationPolicyV1: { configuredSandboxes: {}, workKinds: {
            sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' },
          } },
        } }),
      });
      expect(result).toMatchObject({ ok: false, sessionSpawnRequired: { machineId: 'machine-1' } });
      expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.safeParse(result).success).toBe(true);
      expect(await fixture.bootstrapFiles()).toEqual([]);
    });
  });
  it.each(['setup_pending', 'off', 'unread'] as const)('answers a fresh foreground Codex start with %s Machine policy while binding is pending', async state => {
    await withForegroundProviderFixture({}, async fixture => {
      const binding = Promise.withResolvers<void>();
      const { machineId, ...request } = fixture.request({ profileId: undefined, selection: undefined });
      const owner = createForegroundAgentRuntimeAdmissionOwner({
        prepare: (admitted, signal) => fixture.prepare(admitted, {
          signal,
          readMachineMetadataSnapshot: () => state === 'unread' ? { status: 'unavailable' } : {
            status: 'ready', metadataVersion: 1, metadata: state === 'off' ? { agentIsolation: { enabled: false } } : {
              agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' },
              isolationPolicyV1: { configuredSandboxes: {}, workKinds: {
                sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' },
              } },
            },
          },
          agentIsolation: {
            read: () => state === 'unread'
              ? { enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' }, workspaceRoots: [] }
              : state === 'setup_pending'
                ? { enabled: true, memberProvisioning: 'linuxUsersV1',
                  status: { kind: 'unavailable', code: 'provisioning_unavailable' }, workspaceRoots: [] }
                : { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] },
            awaitReadable: () => binding.promise,
          },
        }),
      });
      const controlToken = 'control-token';
      const app = createDaemonControlApp({
        machineId, controlToken, foregroundAgentRuntimeAdmission: owner,
        getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => { throw new Error('Foreground control must not spawn a Session'); },
        requestShutdown: () => undefined, onHappySessionWebhook: () => undefined,
      });
      const originalTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
      delete process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP control address');
        const response = await admitDaemonForegroundAgentRuntime(request, {
          target: { pid: process.pid, httpPort: address.port, controlToken },
        });
        if (state === 'off') {
          expect(response).toMatchObject({ ok: true });
        } else if (state === 'setup_pending') {
          expect(response).toMatchObject({ ok: false, sessionSpawnRequired: { machineId } });
          expect(await fixture.bootstrapFiles()).toEqual([]);
        } else {
          expect(response).toMatchObject({ ok: false, error: {
            kind: 'launch_error', code: 'target_unavailable',
            agentIsolationRefusal: { reason: 'metadata_unavailable', phase: 'native_execution_preparation' },
          } });
          if (response.ok || !('kind' in response.error)) throw new Error('Expected a foreground launch refusal');
          expect(response).not.toHaveProperty('sessionSpawnRequired');
          expect(response.error.message).toContain('try again');
          expect(createForegroundAdmissionError(response.error).message).toBe(
            `target_unavailable: ${response.error.message}`,
          );
          expect(await fixture.bootstrapFiles()).toEqual([]);
        }
      } finally {
        if (originalTimeout !== undefined) process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = originalTimeout;
        await owner.dispose();
        await app.close();
      }
    });
  });
  it('keeps the missing native CLI cause at the strict foreground admission sink', async () => {
    await withForegroundProviderFixture({}, async fixture => {
      vi.stubEnv(resolveAgentCliOverrideEnvKey('codex'), join(fixture.home, 'missing-agent-cli'));
      vi.stubEnv('PATH', '');
      try {
        const refusal = await fixture.prepare({ profileId: undefined });
        expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(refusal)).toMatchObject({
          ok: false, error: { code: 'agent_cli_missing' },
        });
        expect(await fixture.bootstrapFiles()).toEqual([]);
      } finally { vi.unstubAllEnvs(); }
    });
  });
  it('refuses ordinary daemon spawn with a revoked required Profile secret before creating a Session', async () => {
    await withForegroundProviderFixture({
      settings: { version: 1, profileSecretRef: 'happier:shared-secret:v1:resource-profile-shared' },
      sharedSecretFailure: 'reference_forbidden',
    }, async (fixture) => {
      const credentials = await readStoredCredentials();
      if (!credentials) throw new Error('Fixture credentials unavailable');
      const posts = vi.spyOn(axios, 'post');
      const gets = vi.spyOn(axios, 'get');
      const result = await executeSpawnSessionRequest({
        options: { directory: fixture.directory, machineId: 'machine-1', profileId: 'profile-1',
          backendTarget: fixture.request().backendTarget, connectedServices: { v: 2, bindingsByServiceId: {} } },
        credentials, api: await ApiClient.create(credentials),
        connectedServicesMaterializationBaseDir: join(fixture.home, 'connected-services'),
        connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
        connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
        trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
        spawnWebhookTimeoutByKey: new Map(), spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        resolveCanonicalTrackedSessionId: () => '', onChildExited: () => {}, processEnv: {},
      });
      expect(result).toEqual(buildProviderSpawnErrorResult(createProviderErrorV1('provider_secret_missing', { sourceProfileId: 'profile-1',
        savedSecretReason: 'reference_forbidden' })));
      expect(gets.mock.calls.filter(([url]) => url.endsWith('/saved-secrets/resources/materials'))).toHaveLength(1);
      expect(posts.mock.calls.filter(([url]) => /\/sessions(?:\/|$)/.test(url))).toHaveLength(0);
      expect(await fixture.bootstrapFiles()).toEqual([]);
    });
  });

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
        error: createProviderErrorV1('provider_binding_changed', { machineId: 'machine-1', sourceProfileId: 'profile-1',
          savedSecretReason: 'reference_stale' }),
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
        error: createProviderErrorV1('provider_secret_missing', { machineId: 'machine-1', sourceProfileId: 'profile-1',
          savedSecretReason: reason }),
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
        error: createProviderErrorV1('provider_secret_unavailable', { machineId: 'machine-1', sourceProfileId: 'profile-1',
          savedSecretReason: 'reference_unavailable' }),
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
        error: createProviderErrorV1('provider_authorization_changed', { connectionId: fixture.connectionId, machineId: 'machine-1', sourceProfileId: 'profile-1' }),
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
        sensitiveEnvironmentVariableNames: expect.arrayContaining(['PROFILE_SECRET']),
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

  it('admits the foreground Account once at entry and once when the canonical Session binds', async () => {
    await withForegroundProviderFixture({}, async (fixture) => {
      const observed: Array<string | undefined> = [];
      const admitted = await fixture.prepare({}, { isSessionAccountCurrent: async canonicalSessionId => {
        observed.push(canonicalSessionId);
        return true;
      } });
      expect(admitted.ok, !admitted.ok ? JSON.stringify(admitted.error) : undefined).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      expect(observed).toEqual([undefined]);
      const claimed = await admitted.prepared.claim({
        canonicalSessionId: 'canonical-session-once', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed.ok, !claimed.ok ? JSON.stringify(claimed.error) : undefined).toBe(true);
      expect(observed).toEqual([undefined, 'canonical-session-once']);
      await admitted.prepared.cleanup();
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
