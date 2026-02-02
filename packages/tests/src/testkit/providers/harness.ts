import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { createRunDirs } from '../runDir';
import { startServerLight, type StartedServer } from '../process/serverLight';
import { createTestAuth } from '../auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../sessions';
import { envFlag } from '../env';
import { writeTestManifest } from '../manifest';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { repoRootDir } from '../paths';
import { decryptLegacyBase64, encryptLegacyBase64, encodeBase64 } from '../messageCrypto';
import { sleep } from '../timing';
import { createUserScopedSocketCollector } from '../socketClient';

import type { ProviderContractMatrixResult, ProviderScenario, ProviderUnderTest } from './types';
import { opencodeScenarios } from './scenarios';

type ToolTraceEventV1 = {
  v: number;
  ts: number;
  direction: string;
  sessionId: string;
  protocol: string;
  provider?: string;
  kind: string;
  payload: any;
  localId?: string;
};

function yarnCommand(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function which(bin: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const out = (res.stdout || '').trim().split(/\r?\n/)[0];
  return out && out.length > 0 ? out : null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveYoloForScenario(scenario: ProviderScenario): boolean {
  if (typeof scenario.yolo === 'boolean') return scenario.yolo;
  return envFlag('HAPPY_E2E_PROVIDER_YOLO_DEFAULT', true);
}

function readJsonlEvents(raw: string): ToolTraceEventV1[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out: ToolTraceEventV1[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ToolTraceEventV1);
    } catch {
      // ignore
    }
  }
  return out;
}

function keyParts(key: string): { kind: string; toolName: string | null } | null {
  // Examples:
  // - acp/opencode/tool-call/execute
  // - acp/opencode/tool-result/execute
  // - acp/opencode/permission-request/edit
  const parts = key.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const kind = parts[2];
  const toolName = parts.length >= 4 ? parts[3] : null;
  return { kind, toolName };
}

function hasTraceForKey(events: ToolTraceEventV1[], key: string): boolean {
  const p = keyParts(key);
  if (!p) return false;
  const kind = p.kind;
  const toolName = p.toolName;

  if (kind === 'tool-call') {
    if (!toolName) return events.some((e) => e.kind === 'tool-call');
    return events.some((e) => e.kind === 'tool-call' && typeof e.payload?.name === 'string' && e.payload.name === toolName);
  }

  if (kind === 'permission-request') {
    if (!toolName) return events.some((e) => e.kind === 'permission-request');
    return events.some(
      (e) => e.kind === 'permission-request' && typeof e.payload?.toolName === 'string' && e.payload.toolName === toolName,
    );
  }

  if (kind === 'tool-result') {
    // Tool-result does not always include tool name; require at least one tool-result event.
    // If a tool name is specified, also require a tool-call for that tool to have occurred (best-effort correlation).
    const hasAnyResult = events.some((e) => e.kind === 'tool-result' || e.kind === 'tool-call-result');
    if (!hasAnyResult) return false;
    if (!toolName) return true;
    const hasToolCall = events.some((e) => e.kind === 'tool-call' && typeof e.payload?.name === 'string' && e.payload.name === toolName);
    return hasToolCall;
  }

  return false;
}

function scenarioSatisfiedByTrace(events: ToolTraceEventV1[], scenario: ProviderScenario): boolean {
  for (const key of scenario.requiredFixtureKeys) {
    if (!hasTraceForKey(events, key)) return false;
  }
  for (const bucket of scenario.requiredAnyFixtureKeys ?? []) {
    if (!bucket.some((k) => hasTraceForKey(events, k))) return false;
  }
  for (const needle of scenario.requiredTraceSubstrings ?? []) {
    const ok = events.some((e) => JSON.stringify(e.payload ?? {}).includes(needle));
    if (!ok) return false;
  }
  return true;
}

async function readFileText(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(filePath, 'utf8');
}

function providerCatalog(): ProviderUnderTest[] {
  return [
    {
      id: 'opencode',
      enableEnvVar: 'HAPPY_E2E_PROVIDER_OPENCODE',
      protocol: 'acp',
      traceProvider: 'opencode',
      requiresBinaries: ['opencode'],
      cli: {
        subcommand: 'opencode',
        extraArgs: ['--started-by', 'terminal'],
        env: {
          HEADLESS: '1',
          HAPPIER_VARIANT: 'dev',
        },
      },
    },
  ];
}

function scenariosForProvider(providerId: string): ProviderScenario[] {
  if (providerId === 'opencode') return opencodeScenarios;
  return [];
}

function parseScenarioFilter(): { ids: Set<string> | null; tier: 'smoke' | 'extended' | null } {
  const rawIds = typeof process.env.HAPPY_E2E_PROVIDER_SCENARIOS === 'string' ? process.env.HAPPY_E2E_PROVIDER_SCENARIOS.trim() : '';
  if (rawIds) {
    const ids = new Set(rawIds.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    return { ids: ids.size ? ids : null, tier: null };
  }

  const rawTier = typeof process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER === 'string' ? process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER.trim() : '';
  if (!rawTier) return { ids: null, tier: null };
  const tier = rawTier === 'smoke' || rawTier === 'extended' ? rawTier : null;
  return { ids: null, tier };
}

async function runOneScenario(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  server: StartedServer;
  testDir: string;
}): Promise<void> {
  const { provider, scenario, server, testDir } = params;

  const cliHome = resolve(join(testDir, 'cli-home'));
  const workspaceDir = resolve(join(testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  if (scenario.setup) {
    await scenario.setup({ workspaceDir });
  }

  const startedAt = new Date().toISOString();

  const auth = await createTestAuth(server.baseUrl);

  // Legacy encryption is the simplest way to run real provider flows without requiring dataKey provisioning yet.
  const secret = Uint8Array.from(randomBytes(32));

  await (await import('node:fs/promises')).writeFile(
    join(cliHome, 'access.key'),
    `${JSON.stringify({ token: auth.token, secret: encodeBase64(secret) }, null, 2)}\n`,
    'utf8',
  );

  const metadataCiphertextBase64 = encryptLegacyBase64(
    { path: workspaceDir, host: 'e2e', name: `providers-${provider.id}`, createdAt: Date.now() },
    secret,
  );

  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: server.baseUrl,
    token: auth.token,
    tag: `e2e-${provider.id}-${scenario.id}-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });

  // Attach file: lets the CLI attach to an existing session without having created it (resume path).
  const attachDir = resolve(join(cliHome, 'tmp', 'session-attach'));
  await mkdir(attachDir, { recursive: true });
  const attachFile = resolve(join(attachDir, `attach-${sessionId}-${randomUUID()}.json`));
  await (await import('node:fs/promises')).writeFile(
    attachFile,
    JSON.stringify({ encryptionKeyBase64: encodeBase64(secret), encryptionVariant: 'legacy' }),
    { mode: 0o600 },
  );

  const traceFile = resolve(join(testDir, 'tooltrace.jsonl'));
  const fixturesFile = resolve(join(testDir, 'tooltrace.fixtures.v1.json'));
  const cliStdout = resolve(join(testDir, 'cli.stdout.log'));
  const cliStderr = resolve(join(testDir, 'cli.stderr.log'));

  writeTestManifest(testDir, {
    startedAt,
    runId: run.runId,
    testName: `${provider.id}.${scenario.id}`,
    baseUrl: server.baseUrl,
    ports: { server: server.port },
    sessionIds: [sessionId],
    env: {
      HAPPY_E2E_PROVIDERS: process.env.HAPPY_E2E_PROVIDERS,
      [provider.enableEnvVar]: process.env[provider.enableEnvVar],
      HAPPY_E2E_PROVIDER_WAIT_MS: process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
      HAPPY_E2E_PROVIDER_FLAKE_RETRY: process.env.HAPPY_E2E_PROVIDER_FLAKE_RETRY,
    },
  });

  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_HOME_DIR: cliHome,
    HAPPIER_SERVER_URL: server.baseUrl,
    HAPPIER_WEBAPP_URL: server.baseUrl,
    HAPPIER_SESSION_ATTACH_FILE: attachFile,
    HAPPIER_STACK_TOOL_TRACE: '1',
    HAPPIER_STACK_TOOL_TRACE_FILE: traceFile,
    ...(provider.cli.env ?? {}),
  };

  const yolo = resolveYoloForScenario(scenario);

  const proc: SpawnedProcess = spawnLoggedProcess({
    command: yarnCommand(),
    args: [
      '-s',
      'workspace',
      '@happier-dev/cli',
      'dev',
      provider.cli.subcommand,
      '--existing-session',
      sessionId,
      ...(yolo ? ['--yolo'] : []),
      ...(provider.cli.extraArgs ?? []),
    ],
    cwd: repoRootDir(),
    env: cliEnv,
    stdoutPath: cliStdout,
    stderrPath: cliStderr,
  });

  try {
    // Give the CLI time to boot and connect.
    await sleep(2_000);

    // If YOLO is disabled for this scenario, auto-approve any permission requests
    // by watching session agentState.requests and sending `${sessionId}:permission` RPC calls.
    const approvedPermissionIds = new Set<string>();
    const uiSocket = !yolo ? createUserScopedSocketCollector(server.baseUrl, auth.token) : null;
    if (uiSocket) {
      uiSocket.connect();
      // best-effort; do not fail early on connect issues (provider will fail anyway)
      const startedConnectAt = Date.now();
      while (!uiSocket.isConnected() && Date.now() - startedConnectAt < 10_000) {
        await sleep(50);
      }
    }

    const promptLocalId = randomUUID();
    const promptText = scenario.prompt({ workspaceDir });
    const prompt = {
      role: 'user',
      content: { type: 'text', text: promptText },
      localId: promptLocalId,
    };

    const promptCiphertext = encryptLegacyBase64(prompt, secret);
    const msgRes = await fetch(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: promptCiphertext, localId: promptLocalId }),
    });
    if (msgRes.status !== 200) {
      throw new Error(`Failed to post prompt message (status=${msgRes.status})`);
    }

    const maxWaitMs = parsePositiveInt(process.env.HAPPY_E2E_PROVIDER_WAIT_MS, 240_000);
    const startedWaitAt = Date.now();

    let traceRaw = '';
    let traceEvents: ToolTraceEventV1[] = [];
    while (Date.now() - startedWaitAt < maxWaitMs) {
      if (uiSocket) {
        try {
          const snap = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
          const state = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
          const requests = state && typeof state === 'object' ? (state as any).requests : null;
          if (requests && typeof requests === 'object') {
            for (const [id] of Object.entries(requests)) {
              if (typeof id !== 'string' || id.length === 0) continue;
              if (approvedPermissionIds.has(id)) continue;
              const paramsCiphertext = encryptLegacyBase64({ id, approved: true, decision: 'approved' }, secret);
              // Best-effort: if method isn't registered yet, ignore and retry.
              const res = await uiSocket.rpcCall<any>(`${sessionId}:permission`, paramsCiphertext);
              if (res && typeof res === 'object' && res.ok === true) {
                approvedPermissionIds.add(id);
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (existsSync(traceFile)) {
        traceRaw = await readFileText(traceFile).catch(() => '');
        traceEvents = readJsonlEvents(traceRaw);

        const relevant = traceEvents.filter(
          (e) =>
            e?.v === 1 &&
            e.protocol === provider.protocol &&
            (typeof e.provider === 'string' ? e.provider === provider.traceProvider : false),
        );
        if (scenarioSatisfiedByTrace(relevant, scenario)) break;
      }
      await sleep(1_000);
    }

    if (!existsSync(traceFile)) {
      throw new Error('Tool trace file was not created (did provider connect and produce tool events?)');
    }

    // Extract fixtures using the same repo logic used for curated allowlists.
    await runLoggedCommand({
      command: yarnCommand(),
      args: ['-s', 'workspace', '@happier-dev/cli', 'tool:trace:extract', '--out', fixturesFile, traceFile],
      cwd: repoRootDir(),
      env: { ...process.env, CI: '1' },
      stdoutPath: resolve(join(testDir, 'tooltrace.extract.stdout.log')),
      stderrPath: resolve(join(testDir, 'tooltrace.extract.stderr.log')),
      timeoutMs: 120_000,
    });

    const fixturesRaw = await readFileText(fixturesFile);
    const fixtures = JSON.parse(fixturesRaw) as { v?: number; examples?: Record<string, unknown> };
    if (fixtures.v !== 1 || !fixtures.examples || typeof fixtures.examples !== 'object') {
      throw new Error('Invalid fixtures JSON (expected v=1 + examples)');
    }

    const keys = Object.keys(fixtures.examples);
    for (const required of scenario.requiredFixtureKeys) {
      if (!keys.includes(required)) {
        throw new Error(`Missing required fixture key: ${required}`);
      }
    }

    for (const bucket of scenario.requiredAnyFixtureKeys ?? []) {
      const ok = bucket.some((k) => keys.includes(k));
      if (!ok) {
        throw new Error(`Missing required fixture key (any): ${bucket.join(' OR ')}`);
      }
    }

    if (scenario.verify) {
      await scenario.verify({ workspaceDir, fixtures, traceEvents });
    }
    uiSocket?.close();
  } finally {
    await proc.stop();
  }
}

async function runProviderWithRetry(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  server: StartedServer;
  testDir: string;
}): Promise<void> {
  const allowFlakeRetry = envFlag('HAPPY_E2E_PROVIDER_FLAKE_RETRY', false);
  if (!allowFlakeRetry) {
    await runOneScenario(params);
    return;
  }
  try {
    await runOneScenario(params);
  } catch (e1: any) {
    try {
      await runOneScenario(params);
    } catch {
      throw e1;
    }
    throw new Error(`FLAKY: provider scenario passed on retry (${params.provider.id}.${params.scenario.id})`);
  }
}

const run = createRunDirs({ runLabel: 'providers' });

export async function runProviderContractMatrix(): Promise<ProviderContractMatrixResult> {
  if (!envFlag('HAPPY_E2E_PROVIDERS', false)) {
    return { ok: true, skipped: { reason: 'providers disabled (set HAPPY_E2E_PROVIDERS=1)' } };
  }

  const enabledProviders = providerCatalog().filter((p) => envFlag(p.enableEnvVar, false));
  if (enabledProviders.length === 0) {
    return { ok: true, skipped: { reason: 'no providers enabled (set HAPPY_E2E_PROVIDER_*=1)' } };
  }

  let server: StartedServer | null = null;
  try {
    for (const provider of enabledProviders) {
      for (const bin of provider.requiresBinaries ?? []) {
        const resolved = which(bin);
        if (!resolved) {
          throw new Error(`Missing required binary for provider ${provider.id}: ${bin}`);
        }
      }
    }

    const serverDir = run.testDir('server');
    server = await startServerLight({ testDir: serverDir });

    const filter = parseScenarioFilter();

    for (const provider of enabledProviders) {
      let scenarios = scenariosForProvider(provider.id);
      if (filter.ids) scenarios = scenarios.filter((s) => filter.ids!.has(s.id));
      if (filter.tier) scenarios = scenarios.filter((s) => (s.tier ?? 'extended') === filter.tier);
      if (scenarios.length === 0) continue;

      for (const scenario of scenarios) {
        const testDir = run.testDir(`${provider.id}.${scenario.id}`);
        await runProviderWithRetry({ provider, scenario, server, testDir });
      }
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    await server?.stop();
  }
}
