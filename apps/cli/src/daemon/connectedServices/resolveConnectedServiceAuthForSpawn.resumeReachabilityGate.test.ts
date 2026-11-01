import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  QualifiedConnectedAccountListResponseV4Schema,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import {
  ConnectedServiceSpawnResumeUnreachableError,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';

/**
 * §2 spawn-time resume-reachability re-verify gate (K1 §2).
 *
 * The gate runs AFTER `materializeConnectedServicesForSpawn` against the REAL materialized env the
 * vendor will read, and BEFORE the spawn returns the env. It proves the TARGET (per §2 — not "hope
 * the import lands"): a genuinely-missing resumed session fails closed with a structured continuity
 * error instead of letting the spawned vendor crash resuming a missing file. A native file present
 * on disk (imported into the materialized target) is proven reachable (D8). Fresh / isolated spawns
 * are never gated.
 *
 * These exercise the real PI materializer + real filesystem. Only Account API boundaries are
 * substituted: qualified profile metadata and the sealed token credential.
 */

const PI_NATIVE_SESSION_ID = '019e461b-0000-7000-8000-000000000000';
const PI_NATIVE_SESSION_FILE = `2026-05-20T15-57-24-578Z_${PI_NATIVE_SESSION_ID}.jsonl`;
const PI_NATIVE_SESSION_CONTENT = `{"id":"${PI_NATIVE_SESSION_ID}"}\n`;

const tempDirs: string[] = [];
const materializationCleanups: Array<() => Promise<void>> = [];
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;

beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.pi', 'happier.voice.openai'] },
  });
});
afterAll(async () => { await runtime?.dispose(); });

afterEach(async () => {
  await Promise.all(materializationCleanups.splice(0).map(cleanup => cleanup()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildPiTokenCredentialApiAndCredentials(): Readonly<{
  api: ApiClient;
  credentials: Credentials;
  qualifiedConnectedAccountApi: NonNullable<Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['qualifiedConnectedAccountApi']>;
}> {
  const record = buildConnectedServiceCredentialRecord({
    now: 10,
    serviceId: 'openai',
    profileId: 'work',
    kind: 'token',
    token: {
      token: 'sk-openai-test',
      providerAccountId: null,
      providerEmail: null,
    },
  });

  const credentials: Credentials = {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }

  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret: credentials.encryption.secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const api = {
    getAccountEncryptionMode: async () => 'e2ee' as const,
    getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai' || params.profileId !== 'work') return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: null, expiresAt: null },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' as const,
      };
    },
  } as unknown as ApiClient;

  const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
  const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
    service,
    accounts: [{
      ref: { service, accountId: record.profileId },
      status: 'connected', authenticationModeId: 'api-key',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, scopes: [],
    }],
  });
  return { api, credentials, qualifiedConnectedAccountApi: {
    listAccounts: async ({ service: requestedService }) => {
      expect(requestedService).toEqual(service);
      return accounts;
    },
    readGroup: async () => { throw new Error('Profile-bound PI resume must not read an Account group'); },
  } };
}

const sharedPiAccountSettings = {
  connectedServicesProviderStateSharingSettingsV1: {
    v: 1,
    defaults: { configMode: 'linked', stateMode: 'isolated' },
    byAgentId: { pi: { stateMode: 'shared' } },
    acknowledgedRisksByAgentId: {},
  },
} as const;

const piBindings = {
  v: 1,
  bindingsByServiceId: {
    openai: { source: 'connected', profileId: 'work' },
  },
} as const;

async function writeNativePiSessionFile(params: Readonly<{
  piAgentDir: string;
  cwd: string;
}>): Promise<string> {
  const encodedCwdDir = formatPiSessionDirectoryForCwd(params.cwd);
  const nativeSessionsDir = join(params.piAgentDir, 'sessions', encodedCwdDir);
  await mkdir(nativeSessionsDir, { recursive: true });
  const path = join(nativeSessionsDir, PI_NATIVE_SESSION_FILE);
  await writeFile(path, PI_NATIVE_SESSION_CONTENT);
  return path;
}

async function callSpawn(params: Readonly<{
  cwd: string;
  piAgentDir?: string | null;
  vendorResumeId?: string | null;
  resumeReachabilityRequired?: boolean;
  candidatePersistedSessionFile?: string | null;
}>) {
  const baseDir = await makeTempDir('happier-pi-gate-base-');
  const activeServerDir = await makeTempDir('happier-pi-gate-server-');
  const { api, credentials, qualifiedConnectedAccountApi } = buildPiTokenCredentialApiAndCredentials();
  const { owner } = createForegroundPurposeOwnerFixture({
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    service: { pluginId: 'happier.voice.openai', localId: 'openai' },
    accountId: 'work',
    // PI's API-key purpose has no launch-time file or request-header materialization.
    materializeAccount: async () => { throw new Error('Unexpected PI Account credential materialization'); },
  });

  const result = await resolveConnectedServiceAuthForSpawn({
    agentId: 'pi',
    connectedServicesBindingsRaw: piBindings,
    materializationKey: 'pi-gate-session',
    activeServerDir,
    baseDir,
    sessionDirectory: params.cwd,
    credentials,
    api,
    qualifiedConnectedAccountApi,
    connectedAccountsOwner: owner,
    activateQualifiedPurposeBindings: snapshot => owner.activateSessionPurposeBindings({
      sessionId: 'pi-gate-session', purposes: snapshot.purposes, bindings: snapshot.bindings,
    }),
    accountSettings: sharedPiAccountSettings,
    processEnv: {
      ...process.env,
      ...(params.piAgentDir ? { PI_CODING_AGENT_DIR: params.piAgentDir } : { PI_CODING_AGENT_DIR: '' }),
    },
    vendorResumeId: params.vendorResumeId ?? null,
    resumeReachabilityRequired: params.resumeReachabilityRequired ?? false,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
    resolveQualifiedPurposeBindingSnapshot: (bindings) =>
      resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: 'pi',
        bindings,
        contributions: runtime.registry.contributes,
      }),
  });
  if (result) materializationCleanups.push(async () => {
    await result.materializationPurposeLease?.dispose();
    await result.cleanupOnExit?.();
  });
  return result;
}

describe('resolveConnectedServiceAuthForSpawn §2 resume-reachability gate', () => {
  it('surfaces the shared continuity error taxonomy on a genuine miss', async () => {
    const cwd = await makeTempDir('happier-pi-gate-project-taxonomy-');
    const piAgentDir = await makeTempDir('happier-pi-gate-native-empty-tax-');

    const error = await callSpawn({
      cwd,
      piAgentDir,
      vendorResumeId: PI_NATIVE_SESSION_ID,
      resumeReachabilityRequired: true,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConnectedServiceSpawnResumeUnreachableError);
    const gateError = error as ConnectedServiceSpawnResumeUnreachableError;
    expect(gateError.errorCode).toBe('provider_session_state_unavailable_for_resume');
    expect(gateError.failurePhase).toBe('continuity');
    expect(gateError.agentId).toBe('pi');
    expect(gateError.vendorResumeId).toBe(PI_NATIVE_SESSION_ID);
  });

  it('does not gate a spawn when shared-state continuity is not required (isolated)', async () => {
    const cwd = await makeTempDir('happier-pi-gate-project-isolated-');
    const piAgentDir = await makeTempDir('happier-pi-gate-native-isolated-');

    const result = await callSpawn({
      cwd,
      piAgentDir,
      vendorResumeId: PI_NATIVE_SESSION_ID,
      resumeReachabilityRequired: false,
    });
    expect(result).not.toBeNull();
  });

  it('does not gate a fresh (no vendor resume reference) spawn', async () => {
    const cwd = await makeTempDir('happier-pi-gate-project-fresh-');
    const piAgentDir = await makeTempDir('happier-pi-gate-native-fresh-');

    const result = await callSpawn({
      cwd,
      piAgentDir,
      vendorResumeId: null,
      resumeReachabilityRequired: true,
    });
    expect(result).not.toBeNull();
  });

  it('passes the gate when the native PI session file exists and is imported into the materialized target', async () => {
    const cwd = await makeTempDir('happier-pi-gate-project-native-hit-');
    const piAgentDir = await makeTempDir('happier-pi-gate-native-hit-src-');
    await writeNativePiSessionFile({ piAgentDir, cwd });

    const result = await callSpawn({
      cwd,
      piAgentDir,
      vendorResumeId: PI_NATIVE_SESSION_ID,
      resumeReachabilityRequired: true,
    });
    expect(result).not.toBeNull();
    // The native file must have been imported into the materialized target the vendor reads.
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const importedPath = join(result!.env.PI_CODING_AGENT_DIR, 'sessions', encodedCwdDir, PI_NATIVE_SESSION_FILE);
    await expect(stat(importedPath).then((s) => s.isFile())).resolves.toBe(true);
  });

  it('degrades a stale absolute persisted-session-file hint to the native id+cwd search (D8), never hard-failing', async () => {
    const cwd = await makeTempDir('happier-pi-gate-project-d8-');
    const piAgentDir = await makeTempDir('happier-pi-gate-native-d8-src-');
    await writeNativePiSessionFile({ piAgentDir, cwd });

    // A persisted absolute path recorded on another machine that does not exist here. Per D8 this is
    // a fast-path hint only; its staleness must fall through to the native id+cwd search and still
    // prove reachable, not hard-fail.
    const stalePersistedPath = join(
      '/nonexistent-machine-root',
      'sessions',
      'whatever',
      PI_NATIVE_SESSION_FILE,
    );

    const result = await callSpawn({
      cwd,
      piAgentDir,
      vendorResumeId: PI_NATIVE_SESSION_ID,
      resumeReachabilityRequired: true,
      candidatePersistedSessionFile: stalePersistedPath,
    });
    expect(result).not.toBeNull();
  });

  it('checks declared Session state rather than failing on an obsolete cwd prerequisite', async () => {
    const piAgentDir = await makeTempDir('happier-pi-gate-native-nocwd-');

    const error = await callSpawn({
      cwd: '',
      piAgentDir,
      vendorResumeId: PI_NATIVE_SESSION_ID,
      resumeReachabilityRequired: true,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConnectedServiceSpawnResumeUnreachableError);
    const gateError = error as ConnectedServiceSpawnResumeUnreachableError;
    expect(gateError.errorCode).toBe('provider_session_state_unavailable_for_resume');
    expect(gateError.failurePhase).toBe('continuity');
    expect(gateError.reason).toBe('pi_session_file_not_found');
  });
});
