import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { createTempPathBin, type TempPathBin } from '../../src/testkit/fs/tempPathBin';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { sleep } from '../../src/testkit/timing';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
} from '../../src/testkit/providers/scenarios/sessionRuntime';

const run = createRunDirs({ runLabel: 'core' });

type SpawnResponse = {
  success?: unknown;
  sessionId?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

type FakeAgyLogEvent = Record<string, unknown>;

function parseJsonl(raw: string): FakeAgyLogEvent[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as FakeAgyLogEvent]
          : [];
      } catch {
        return [];
      }
    });
}

async function readFakeAgyLog(logPath: string): Promise<FakeAgyLogEvent[]> {
  return parseJsonl(await readFile(logPath, 'utf8').catch(() => ''));
}

async function waitForFakeAgyEvent(
  logPath: string,
  predicate: (event: FakeAgyLogEvent) => boolean,
): Promise<FakeAgyLogEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const events = await readFakeAgyLog(logPath);
    const found = events.find((event) => {
      try {
        return predicate(event);
      } catch {
        return false;
      }
    });
    if (found) return found;
    await sleep(100);
  }
  const events = await readFakeAgyLog(logPath);
  throw new Error(`Timed out waiting for fake agy event in ${logPath}; events=${JSON.stringify(events.slice(-5))}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readAntigravityMetadata(metadata: unknown): {
  agentId: string | null;
  agyConversationId: string | null;
} {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const descriptor = record.runtimeDescriptorV1 && typeof record.runtimeDescriptorV1 === 'object' && !Array.isArray(record.runtimeDescriptorV1)
    ? record.runtimeDescriptorV1 as Record<string, unknown>
    : {};
  const provider = descriptor.provider && typeof descriptor.provider === 'object' && !Array.isArray(descriptor.provider)
    ? descriptor.provider as Record<string, unknown>
    : {};
  return {
    agentId: typeof descriptor.agentId === 'string' ? descriptor.agentId : null,
    agyConversationId: typeof provider.agyConversationId === 'string'
      ? provider.agyConversationId
      : typeof record.antigravitySessionId === 'string'
        ? record.antigravitySessionId
      : typeof record.agyConversationId === 'string'
        ? record.agyConversationId
        : null,
  };
}

async function readSessionAntigravityMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<ReturnType<typeof readAntigravityMetadata>> {
  const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  const metadata = decryptLegacyBase64(snap.metadata, params.secret);
  return readAntigravityMetadata(metadata);
}

async function waitForSessionAntigravityMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  expectedConversationId: string;
}>): Promise<ReturnType<typeof readAntigravityMetadata>> {
  const startedAt = Date.now();
  let last = await readSessionAntigravityMetadata(params);
  while (Date.now() - startedAt < 30_000) {
    if (
      last.agentId === 'antigravity'
      && last.agyConversationId === params.expectedConversationId
    ) {
      return last;
    }
    await sleep(100);
    last = await readSessionAntigravityMetadata(params);
  }
  throw new Error(
    `Timed out waiting for Antigravity runtime identity publication; `
      + `expectedConversationId=${params.expectedConversationId} last=${JSON.stringify(last)}`,
  );
}

function fakeAgyScript(): string {
  return String.raw`#!/usr/bin/env node
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const logPath = process.env.HAPPIER_E2E_FAKE_AGY_LOG;
const conversationId = process.env.HAPPIER_E2E_FAKE_AGY_CONVERSATION_ID || 'fake-agy-conversation';

function log(event) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ ts: Date.now(), pid: process.pid, ...event }) + '\n');
}

function readPrintPrompt(args, stdin) {
  const printIndex = args.includes('-p') ? args.indexOf('-p') : args.indexOf('--print');
  const argPrompt = printIndex >= 0 ? args[printIndex + 1] || '' : '';
  return argPrompt.trim() ? argPrompt : stdin.trim();
}

if (args.includes('--dangerously-skip-permissions')) {
  log({ type: 'unsafe_skip_rejected', argv: args });
  process.stderr.write('unsafe skip permissions is forbidden in fake agy\n');
  process.exit(44);
}

if (args.length === 1 && args[0] === 'models') {
  log({ type: 'models', argv: args });
  process.stdout.write('Gemini 3.5 Flash (Medium)\n');
  process.exit(0);
}

if (!args.includes('-p') && !args.includes('--print')) {
  const conversationIndex = args.indexOf('--conversation');
  const requestedConversation = conversationIndex >= 0 ? args[conversationIndex + 1] || null : null;
  const effectiveConversationId = requestedConversation || conversationId;
  const marker = process.env.HAPPIER_E2E_FAKE_AGY_TERMINAL_MARKER || 'FAKE_AGY_TERMINAL_FOLLOW';
  const home = process.env.HOME || process.cwd();
  const transcriptDir = join(home, '.gemini', 'antigravity-cli', 'brain', effectiveConversationId, '.system_generated', 'logs');
  mkdirSync(transcriptDir, { recursive: true });
  appendFileSync(
    join(transcriptDir, 'transcript_full.jsonl'),
    JSON.stringify({
      id: 'fake-agy-terminal-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      type: 'PLANNER_RESPONSE',
      text: marker,
      conversationId: effectiveConversationId,
      created_at: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
  log({
    type: 'terminal',
    argv: args,
    conversationArg: requestedConversation,
    conversationId: effectiveConversationId,
    marker,
    cwd: process.cwd(),
    executable: process.argv[1],
  });
  process.on('SIGTERM', () => {
    log({
      type: 'terminal_sigterm',
      conversationId: effectiveConversationId,
    });
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  process.stdin.on('end', () => {
    const conversationIndex = args.indexOf('--conversation');
    const requestedConversation = conversationIndex >= 0 ? args[conversationIndex + 1] || null : null;
    const effectiveConversationId = requestedConversation || conversationId;
    const prompt = readPrintPrompt(args, stdin);
    const response = 'FAKE_AGY_ASSISTANT_STDOUT ' + prompt;
    const home = process.env.HOME || process.cwd();
    const transcriptDir = join(home, '.gemini', 'antigravity-cli', 'brain', effectiveConversationId, '.system_generated', 'logs');
    mkdirSync(transcriptDir, { recursive: true });
    appendFileSync(
      join(transcriptDir, 'transcript_full.jsonl'),
      JSON.stringify({
        id: 'fake-agy-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        type: 'assistant',
        text: response,
        conversationId: effectiveConversationId,
      }) + '\n',
      'utf8',
    );
    log({
      type: 'print',
      argv: args,
      prompt,
      stdin,
      stdinEnded: true,
      conversationArg: requestedConversation,
      conversationId: effectiveConversationId,
      cwd: process.cwd(),
      executable: process.argv[1],
    });
    process.stdout.write(response + '\n');
  });
}
`;
}

async function installFakeAgy(pathBin: TempPathBin): Promise<string> {
  const agyPath = pathBin.resolveCommandPath(process.platform === 'win32' ? 'agy.cmd' : 'agy');
  if (process.platform === 'win32') {
    const scriptPath = pathBin.resolveCommandPath('agy.js');
    await writeFile(scriptPath, fakeAgyScript(), 'utf8');
    await writeFile(agyPath, `@echo off\r\n"${process.execPath}" "%~dp0agy.js" %*\r\n`, 'utf8');
    return agyPath;
  }
  await writeFile(agyPath, fakeAgyScript(), 'utf8');
  await chmod(agyPath, 0o755);
  return agyPath;
}

describe('core e2e: Antigravity cliPrint mode resolution with fake agy', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;
  let tempPathBin: TempPathBin | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;

  afterEach(async () => {
    ui?.close();
    ui = null;
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
    await tempPathBin?.cleanup().catch(() => {});
    tempPathBin = null;
  });

  afterAll(async () => {
    ui?.close();
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
    }
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    await tempPathBin?.cleanup().catch(() => {});
  });

  it('starts explicit cliPrint without localharness credentials and sends the turn through agy print mode', async () => {
    const testDir = run.testDir(`antigravity-cliprint-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });

    tempPathBin = await createTempPathBin({
      prefix: 'fake-agy-bin-',
      baseDir: testDir,
      env: process.env,
    });
    const fakeAgyPath = await installFakeAgy(tempPathBin);
    const fakeLogPath = resolve(join(testDir, 'fake-agy.jsonl'));
    const expectedConversationId = `fake-agy-conversation-${randomUUID()}`;
    const terminalFollowMarker = `ANTIGRAVITY_TERMINAL_FOLLOW_${randomUUID()}`;
    const daemonEnv = tempPathBin.extendEnv({
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HOME: daemonHomeDir,
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_FAKE_AGY_LOG: fakeLogPath,
      HAPPIER_E2E_FAKE_AGY_CONVERSATION_ID: expectedConversationId,
      HAPPIER_E2E_FAKE_AGY_TERMINAL_MARKER: terminalFollowMarker,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      snapshotDir: resolve(join(testDir, 'cli-source-snapshot')),
    });

    const spawnRes = await daemonControlPostJson<SpawnResponse>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'antigravity' },
        terminal: { mode: 'plain' },
        environmentVariables: daemonEnv,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'antigravity',
          provider: {
            runtimeMode: 'cliPrint',
          },
        },
      },
      timeoutMs: 120_000,
    });
    expect(spawnRes.status, JSON.stringify(spawnRes.data)).toBe(200);
    expect(spawnRes.data.success, JSON.stringify(spawnRes.data)).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`Missing Antigravity sessionId from daemon spawn-session: ${JSON.stringify(spawnRes.data)}`);
    }

    await waitForFakeAgyEvent(fakeLogPath, (event) => event.type === 'models');

    const prompt = `ANTIGRAVITY_CLIPRINT_PROMPT_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: prompt,
    });

    const printEvent = await waitForFakeAgyEvent(fakeLogPath, (event) => event.type === 'print');
    const argv = isStringArray(printEvent.argv) ? printEvent.argv : [];
    expect(argv).toContain('-p');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--sandbox');
    const addDirIndex = argv.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(resolve(argv[addDirIndex + 1] ?? '')).toBe(workspaceDir);
    expect(printEvent.stdinEnded).toBe(true);
    expect(printEvent.prompt).toContain(prompt);
    expect(printEvent.conversationArg).toBeNull();
    expect(printEvent.conversationId).toBe(expectedConversationId);
    expect(basename(String(printEvent.executable ?? ''))).toMatch(/^agy(?:\.cmd)?$/);
    expect(fakeAgyPath).toContain('agy');

    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: 'FAKE_AGY_ASSISTANT_STDOUT',
      timeoutMs: 120_000,
    });

    const antigravityMetadata = await waitForSessionAntigravityMetadata({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      expectedConversationId,
    });
    expect(antigravityMetadata.agentId).toBe('antigravity');
    expect(antigravityMetadata.agyConversationId).toBe(expectedConversationId);

    const resumePrompt = `ANTIGRAVITY_CLIPRINT_RESUME_PROMPT_${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: resumePrompt,
    });

    const resumePrintEvent = await waitForFakeAgyEvent(
      fakeLogPath,
      (event) => event.type === 'print' && event.conversationArg === expectedConversationId,
    );
    const resumeArgv = isStringArray(resumePrintEvent.argv) ? resumePrintEvent.argv : [];
    const conversationArgIndex = resumeArgv.indexOf('--conversation');
    expect(conversationArgIndex).toBeGreaterThanOrEqual(0);
    expect(resumeArgv[conversationArgIndex + 1]).toBe(expectedConversationId);
    expect(resumePrintEvent.stdinEnded).toBe(true);
    expect(resumePrintEvent.prompt).toContain(resumePrompt);
    expect(resumePrintEvent.conversationId).toBe(expectedConversationId);

    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: resumePrompt,
      timeoutMs: 120_000,
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    const uiConnectedStartedAt = Date.now();
    while (!ui.isConnected() && Date.now() - uiConnectedStartedAt < 20_000) {
      await sleep(50);
    }
    expect(ui.isConnected()).toBe(true);

    const switchedToLocal = await requestSessionSwitchRpc({
      ui,
      sessionId,
      to: 'local',
      secret,
      timeoutMs: 30_000,
    });
    expect(switchedToLocal).toBe(true);

    const terminalEvent = await waitForFakeAgyEvent(
      fakeLogPath,
      (event) => event.type === 'terminal' && event.marker === terminalFollowMarker,
    );
    const terminalArgv = isStringArray(terminalEvent.argv) ? terminalEvent.argv : [];
    const terminalConversationArgIndex = terminalArgv.indexOf('--conversation');
    expect(terminalConversationArgIndex).toBeGreaterThanOrEqual(0);
    expect(terminalArgv[terminalConversationArgIndex + 1]).toBe(expectedConversationId);
    expect(terminalEvent.conversationArg).toBe(expectedConversationId);
    expect(terminalEvent.conversationId).toBe(expectedConversationId);

    await waitForAssistantMessageContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: terminalFollowMarker,
      timeoutMs: 120_000,
    });

    const switchedToRemote = await requestSessionSwitchRpc({
      ui,
      sessionId,
      to: 'remote',
      secret,
      timeoutMs: 30_000,
    });
    expect(switchedToRemote).toBe(true);
    await waitForFakeAgyEvent(
      fakeLogPath,
      (event) => event.type === 'terminal_sigterm' && event.conversationId === expectedConversationId,
    );

    const events = await readFakeAgyLog(fakeLogPath);
    expect(events.some((event) => event.type === 'unsafe_skip_rejected')).toBe(false);
    expect(events.filter((event) => event.type === 'print')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'terminal_sigterm')).toHaveLength(1);
  }, 600_000);
});
