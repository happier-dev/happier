import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { GEMINI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

const SESSION_ID = '12740866-141f-4f73-afab-76bd38cf2e87';
const CHAT_FILE_NAME = `session-2026-05-20T07-57-${SESSION_ID.slice(0, 8)}.jsonl`;

type GeminiRuntimeConnectedServices = Readonly<{
  verifyResumeReachable?: (input: Readonly<{
    targetMaterializedRoot: string;
    targetMaterializedEnv: Readonly<Record<string, string>>;
    vendorResumeId: string | null;
    cwd: string;
    candidatePersistedSessionFile?: string | null;
    targetStrict?: boolean;
  }>) => Promise<Readonly<{ ok: true; resolvedPath: string | null } | { ok: false; reason: string }>>;
}>;

function readRuntimeConnectedServices(): GeminiRuntimeConnectedServices {
  const contribution = GEMINI_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
    connectedServices?: GeminiRuntimeConnectedServices;
  }>;
  return contribution.connectedServices ?? {};
}

async function writeGeminiChatFixture(params: Readonly<{
  homeDir: string;
  slug: string;
  cwd?: string;
}>): Promise<string> {
  const chatsDir = join(params.homeDir, '.gemini', 'tmp', params.slug, 'chats');
  await mkdir(chatsDir, { recursive: true });
  const filePath = join(chatsDir, CHAT_FILE_NAME);
  await writeFile(filePath, [
    JSON.stringify({ sessionId: SESSION_ID, projectHash: 'hash', kind: 'main' }),
    JSON.stringify({ type: 'user', content: [{ text: 'hello' }] }),
  ].join('\n'), 'utf8');
  if (params.cwd) {
    await writeFile(
      join(params.homeDir, '.gemini', 'projects.json'),
      JSON.stringify({ projects: { [params.cwd]: params.slug } }),
      'utf8',
    );
  }
  return filePath;
}

describe('GEMINI_AGENT_RUNTIME_CONTRIBUTION connected services', () => {
  let fakeNativeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    fakeNativeHome = await mkdtemp(join(tmpdir(), 'gemini-native-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeNativeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(fakeNativeHome, { recursive: true, force: true });
  });

  it('leaves spawn prerequisites to the generation-owned activation hook', () => {
    expect(GEMINI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('daemonSpawnHooks');
  });

  it('exports a token-only cloud connect target for registry projection', async () => {
    expect(GEMINI_AGENT_RUNTIME_CONTRIBUTION.cloudConnect).toMatchObject({
      displayName: 'Gemini',
      vendorDisplayName: 'Google Gemini',
      vendorKey: 'gemini',
      status: 'wired',
    });

    await expect(
      GEMINI_AGENT_RUNTIME_CONTRIBUTION.cloudConnect.customAuthenticator.authenticate(),
    ).resolves.toMatchObject({
      ok: false,
      code: 'unsupported',
    });
  });

  it('exports API-key and Vertex connected-service materialization without OAuth closure', async () => {
    const connectedServices = GEMINI_AGENT_RUNTIME_CONTRIBUTION.connectedServices;
    const now = 1_700_000_000_000;
    const apiKey = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-api',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const vertex = {
      ...apiKey,
      profileId: 'gemini-vertex',
      token: {
        ...apiKey.token,
        raw: {
          vertexAi: {
            project: 'vertex-project',
            location: 'us-central1',
          },
        },
      },
    };
    const oauth = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-oauth',
      kind: 'oauth',
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(connectedServices.serviceIds).toEqual(['gemini']);
    expect(connectedServices.readConnectedServiceId({ serviceId: 'gemini' })).toBe('gemini');
    expect(connectedServices.readConnectedServiceId({ serviceId: 'anthropic' })).toBeNull();
    expect(connectedServices.shouldRestartForServiceSwitch?.({ serviceId: 'gemini' })).toBe(true);
    expect(connectedServices.shouldRestartForServiceSwitch?.({ serviceId: 'anthropic' })).toBe(false);
    expect(connectedServices.shouldRestartForServiceSwitch?.(null)).toBe(false);
    expect(connectedServices.createAuthMaterializationInput('gemini', apiKey)).toEqual({ gemini: apiKey });
    expect(connectedServices.stateSharingDescriptor).toMatchObject({
      providerId: 'gemini',
      authIsolation: {
        mode: 'process_env',
        secretEntries: expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
      },
    });

    await expect(connectedServices.materializeAuthEnvironment({ gemini: apiKey })).resolves.toEqual({
      env: {
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        GEMINI_API_KEY: 'gemini-api-key',
        GOOGLE_API_KEY: 'gemini-api-key',
      },
    });
    await expect(connectedServices.materializeAuthEnvironment({ gemini: vertex })).resolves.toEqual({
      env: {
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        GOOGLE_GENAI_USE_VERTEXAI: '1',
        GOOGLE_CLOUD_PROJECT: 'vertex-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    });
    await expect(connectedServices.materializeAuthEnvironment({ gemini: oauth })).resolves.toEqual({
      env: {},
      diagnostics: [{
        code: 'gemini_oauth_deferred_api_key_or_vertex_required',
        providerId: 'gemini',
        serviceId: 'gemini',
        severity: 'blocking',
      }],
    });
    await expect(connectedServices.materializeAuthEnvironment({
      gemini: {
        ...oauth,
        authenticationModeId: 'legacy-oauth-unsupported',
      },
    })).resolves.toEqual({
      env: {},
      diagnostics: [{
        code: 'gemini_oauth_deferred_api_key_or_vertex_required',
        providerId: 'gemini',
        serviceId: 'gemini',
        severity: 'blocking',
      }],
    });
  });

  it('proves only provider activity bound to the exact Gemini credential epoch', async () => {
    const adapter = GEMINI_AGENT_RUNTIME_CONTRIBUTION.connectedServices.runtimeAuthAdapter as unknown as Readonly<{
      verifyProviderOutcome?: (input: unknown) => Promise<unknown>;
    }>;
    const exactSelection = {
      kind: 'group',
      serviceId: 'gemini',
      groupId: 'gemini-pool',
      activeProfileId: 'gemini-api',
      fallbackProfileId: 'gemini-api',
      generation: 7,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    };

    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'gemini' },
      selections: [exactSelection],
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toEqual({
      status: 'verified',
      source: 'gemini_provider_activity',
      targets: [{
        serviceId: 'gemini',
        profileId: 'gemini-api',
        groupId: 'gemini-pool',
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
    });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'gemini' },
      selections: [{ ...exactSelection, credentialRevision: undefined }],
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'gemini' },
      selections: [exactSelection],
      outcome: { kind: 'provider_activity', event: 'task_started' },
    })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome?.({
      target: { agentId: 'gemini' },
      selections: [exactSelection],
      outcome: { kind: 'quota_unknown' },
    })).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('exports Gemini resume reachability through the native connected-service contribution', async () => {
    const connectedServices = readRuntimeConnectedServices();

    expect(GEMINI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('runtimeControl');
    expect(connectedServices.verifyResumeReachable).toEqual(expect.any(Function));
    await expect(connectedServices.verifyResumeReachable?.({
      targetMaterializedRoot: '/tmp/missing-gemini-materialized-root',
      targetMaterializedEnv: {},
      vendorResumeId: null,
      cwd: '/tmp/project',
    })).resolves.toEqual({ ok: false, reason: 'gemini_session_file_not_found' });
  });

  it('proves Gemini resume reachability from the final target home under targetStrict', async () => {
    const connectedServices = readRuntimeConnectedServices();
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-target-root-'));
    const homeDir = join(rootDir, 'home');
    const cwd = '/workspace/my-project';
    const filePath = await writeGeminiChatFixture({ homeDir, slug: 'my-project', cwd });

    await expect(connectedServices.verifyResumeReachable?.({
      targetMaterializedRoot: rootDir,
      targetMaterializedEnv: { HOME: homeDir, GEMINI_CLI_HOME: homeDir },
      vendorResumeId: SESSION_ID,
      cwd,
      targetStrict: true,
    })).resolves.toEqual({ ok: true, resolvedPath: filePath });
  });

  it('imports a Gemini chat session into the materialized home during auth materialization', async () => {
    const connectedServices = GEMINI_AGENT_RUNTIME_CONTRIBUTION.connectedServices;
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-materialized-root-'));
    const sourceHome = await mkdtemp(join(tmpdir(), 'gemini-source-home-'));
    const cwd = '/workspace/my-project';
    const sourcePath = await writeGeminiChatFixture({ homeDir: sourceHome, slug: 'my-project', cwd });
    const now = 1_700_000_000_000;
    const apiKey = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'gemini-api',
      kind: 'token',
      token: {
        token: 'gemini-api-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await connectedServices.materializeAuthEnvironment({
      gemini: apiKey,
      rootDir,
      processEnv: { HOME: sourceHome },
      sessionDirectory: cwd,
      vendorResumeId: SESSION_ID,
    });

    const destinationPath = join(rootDir, 'home', '.gemini', 'tmp', 'my-project', 'chats', CHAT_FILE_NAME);
    expect(await readFile(destinationPath, 'utf8')).toBe(await readFile(sourcePath, 'utf8'));
    await expect(
      readFile(join(rootDir, 'home', '.gemini', 'projects.json'), 'utf8'),
    ).resolves.toBe(`${JSON.stringify({ projects: { [cwd]: 'my-project' } }, null, 2)}\n`);
  });
});
