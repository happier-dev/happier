import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/protocol';

import { writeFakeCodexAppServerThreadListScript } from '@/session/external/testkit/fakeCodexAppServer';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';
import { resolveDirectTakeoverSpawnOptions } from './resolveDirectTakeoverSpawnOptions';

const listSessionMarkersMock = vi.fn();

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    isDaemonProcess: false,
  },
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: (...args: unknown[]) => listSessionMarkersMock(...args),
}));

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function createLinkedCodexSessionFixture(params: Readonly<{
  remoteSessionId: string;
  source: LoadedLinkedExternalSession['source'];
  sessionPath?: string | null;
  metadata?: LoadedLinkedExternalSession['metadata'];
  codexBackendMode?: CodexBackendMode;
}>): LoadedLinkedExternalSession {
  const metadata = params.metadata ?? (params.codexBackendMode
    ? {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: params.codexBackendMode,
          },
        },
      }
    : {});
  return {
    rawSession: {} as RawSessionRecord,
    metadata,
    sessionPath: params.sessionPath ?? null,
    agentId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: params.codexBackendMode ?? null,
  };
}

function createLinkedOpenCodeSessionFixture(params: Readonly<{
  remoteSessionId: string;
  source: LoadedLinkedExternalSession['source'];
  sessionPath?: string | null;
}>): LoadedLinkedExternalSession {
  return {
    rawSession: {} as RawSessionRecord,
    metadata: {},
    sessionPath: params.sessionPath ?? null,
    agentId: 'opencode',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: null,
  };
}

function createLinkedOhMyPiSessionFixture(params: Readonly<{
  remoteSessionId: string;
  source: LoadedLinkedExternalSession['source'];
  sessionPath?: string | null;
  metadata?: LoadedLinkedExternalSession['metadata'];
}>): LoadedLinkedExternalSession {
  return {
    rawSession: {} as RawSessionRecord,
    metadata: params.metadata ?? {},
    sessionPath: params.sessionPath ?? null,
    agentId: 'ohMyPi',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: null,
  };
}

describe('resolveDirectTakeoverSpawnOptions', () => {
  const connectedServices = {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: 'codex-main',
        profileId: 'backup',
      },
    },
  };
  const materializationIdentity = {
    v: 1 as const,
    id: 'csm_direct_takeover',
    createdAt: 123,
  };

  beforeEach(() => {
    listSessionMarkersMock.mockResolvedValue([]);
  });

  afterEach(() => {
    listSessionMarkersMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('lets direct Codex takeovers inherit the default backend mode instead of forcing ACP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-'));
    const codexHome = join(root, '.codex');
    const rolloutFile = join(
      codexHome,
      'sessions',
      '2026',
      '03',
      '06',
      'rollout-2026-03-06T00-00-00-11111111-1111-1111-1111-111111111111.jsonl',
    );
    await mkdir(join(codexHome, 'sessions', '2026', '03', '06'), { recursive: true });
    await writeFile(
      rolloutFile,
      jsonlLine({
        type: 'session_meta',
        payload: {
          id: '11111111-1111-1111-1111-111111111111',
          timestamp: '2026-03-06T00:00:00.000Z',
          cwd: '/tmp/direct-codex-takeover-project',
        },
      }),
      'utf8',
    );
    vi.stubEnv('CODEX_HOME', codexHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        source: { kind: 'codexHome', home: 'user' },
      }),
      sessionId: 'sess_happy_direct_codex',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-takeover-project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: '11111111-1111-1111-1111-111111111111',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('keeps app-server codex backend affinity through generic backend mode during direct takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-app-server-'));
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    vi.stubEnv('CODEX_HOME', codexHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        sessionPath: '/tmp/direct-codex-app-server-project',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-app-server-project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: '11111111-1111-1111-1111-111111111111',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      backendMode: 'appServer',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('propagates linked connected-service metadata into direct takeover spawn options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-connected-services-'));
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    vi.stubEnv('CODEX_HOME', codexHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'thread-connected-services',
        sessionPath: '/tmp/direct-codex-connected-services-project',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
        metadata: {
          connectedServices,
          connectedServicesUpdatedAt: 456,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: {
              backendMode: 'appServer',
            },
          },
        },
      }),
      sessionId: 'sess_happy_direct_codex_connected_services',
    });

    expect(spawnOptions).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(JSON.stringify(spawnOptions)).not.toContain('accessToken');
    expect(JSON.stringify(spawnOptions)).not.toContain('refreshToken');
  });

  it('recovers tracked connected-service metadata for catalog-backed ohMyPi direct takeovers', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 654,
        happySessionId: 'sess_source_ohmypi',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 20,
        flavor: 'ohMyPi',
        cwd: '/tmp/direct-ohmypi-connected-services-project',
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'ohMyPi',
            machineId: 'machine-1',
            remoteSessionId: 'omp-thread-connected-services',
            source: { kind: 'ohMyPiAgentDir', agentDir: null },
            linkedAtMs: 1,
          },
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          directory: '/tmp/direct-ohmypi-connected-services-project',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            GEMINI_API_KEY: 'must-not-copy',
          },
        },
      },
    ]);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedOhMyPiSessionFixture({
        remoteSessionId: 'omp-thread-connected-services',
        sessionPath: '/tmp/direct-ohmypi-connected-services-project',
        source: { kind: 'ohMyPiAgentDir', agentDir: null },
        metadata: {
          path: '/tmp/direct-ohmypi-connected-services-project',
          ohMyPiSessionId: 'omp-thread-connected-services',
        },
      }),
      sessionId: 'sess_happy_direct_ohmypi_connected_services',
    });

    expect(spawnOptions).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(JSON.stringify(spawnOptions)).not.toContain('must-not-copy');
  });

  it('refuses ambiguous connected-service Codex takeovers when the source does not identify an exact profile/home', async () => {
    const firstHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-a/codex/codex-home';
    const secondHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-b/codex/codex-home';
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'ambiguous-thread-1',
        sessionPath: '/tmp/direct-codex-ambiguous-project',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_ambiguous',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when an exact homePath belongs to a different service', async () => {
    const foreignHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/other-service/profile-a/codex/codex-home';
    await mkdir(foreignHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-home-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-home-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          homePath: foreignHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_home',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when homePath points below codex-home instead of the exact home', async () => {
    const nestedHome = '/tmp/happier-test-active-server/daemon/connected-services/homes/openai-codex/profile-a/codex/codex-home/sessions';
    await mkdir(nestedHome, { recursive: true });

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-depth-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-depth-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          homePath: nestedHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_depth',
    });

    expect(spawnOptions).toBeNull();
  });

  it('refuses connected-service Codex takeovers when homePath is a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-symlink-'));
    const realHome = join(root, 'daemon', 'connected-services', 'homes', 'other-service', 'profile-a', 'codex', 'codex-home');
    const linkedHome = join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile-a', 'codex', 'codex-home');
    await mkdir(realHome, { recursive: true });
    await mkdir(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile-a', 'codex'), { recursive: true });
    await rm(linkedHome, { recursive: true, force: true });
    await symlink(realHome, linkedHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'wrong-link-thread-1',
        sessionPath: '/tmp/direct-codex-wrong-link-project',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-a',
          homePath: linkedHome,
        },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_wrong_link',
    });

    expect(spawnOptions).toBeNull();
  });

  it('keeps ACP codex backend affinity through generic backend mode during direct takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-acp-'));
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    vi.stubEnv('CODEX_HOME', codexHome);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: 'acp-thread-1',
        sessionPath: '/tmp/direct-codex-acp-project',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'acp',
      }),
      sessionId: 'sess_happy_direct_codex_acp',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-acp-project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess_happy_direct_codex_acp',
      resume: 'acp-thread-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      backendMode: 'acp',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('uses app-server thread cwd when an app-server-linked codex session has no stored path or rollout metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-takeover-codex-app-server-cwd-'));
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [{
        id: '22222222-2222-2222-2222-222222222222',
        cwd: '/tmp/direct-codex-app-server-cwd-project',
        updatedAt: 1_736_000_100,
      }],
    });
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', fakeAppServer);

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedCodexSessionFixture({
        remoteSessionId: '22222222-2222-2222-2222-222222222222',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      }),
      sessionId: 'sess_happy_direct_codex_app_server_cwd',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-codex-app-server-cwd-project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess_happy_direct_codex_app_server_cwd',
      resume: '22222222-2222-2222-2222-222222222222',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      backendMode: 'appServer',
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
    });
  });

  it('marks direct OpenCode server takeovers as explicit server affinity', async () => {
    vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', 'http://127.0.0.1:4096');

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
      linked: createLinkedOpenCodeSessionFixture({
        remoteSessionId: 'opencode-session-1',
        sessionPath: '/tmp/direct-opencode-takeover-project',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:4096',
          directory: '/tmp/direct-opencode-takeover-project',
        },
      }),
      sessionId: 'sess_happy_direct_opencode',
    });

    expect(spawnOptions).toEqual({
      directory: '/tmp/direct-opencode-takeover-project',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      existingSessionId: 'sess_happy_direct_opencode',
      resume: 'opencode-session-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        HAPPIER_OPENCODE_LINKED_SESSION_ID: 'sess_happy_direct_opencode',
      },
    });
  });
});
