import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import {
  accountSettingsParse,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionsCandidatesListResponseSchema,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  type ExternalSessionCandidateV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type NativeAgentId = 'antigravity' | 'ohMyPi' | 'pi';

type NativeSource =
  | Readonly<{ kind: 'antigravityCliPrint' }>
  | Readonly<{ kind: 'ohMyPiAgentDir'; agentDir: string }>
  | Readonly<{ kind: 'piAgentDir'; agentDir: string }>;

type NativeFixture = Readonly<{
  label: string;
  agentId: NativeAgentId;
  source: NativeSource;
  primaryRemoteSessionId: string;
  allRemoteSessionIds: readonly [string, string];
  transcriptMarker: string;
  agentDir?: string;
  assertProjectedSource(source: unknown): void;
}>;

type LinkedFixture = Readonly<{
  fixture: NativeFixture;
  candidate: ExternalSessionCandidateV1;
  sessionId: string;
  source: unknown;
}>;

type PiExactFileFixture = Readonly<{
  fixture: NativeFixture;
  agentDir: string;
  selectedSessionFile: string;
  siblingSessionFile: string;
  linkedDirectory: string;
  targetDirectory: string;
}>;

type DataKeyRpcClient = ReturnType<typeof createDataKeyRpcClient>;

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${context} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${context} to be a non-empty string.`);
  }
  return value;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${context} to be a finite number.`);
  }
  return value;
}

function requireStringArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Expected ${context} to be a string array.`);
  }
  return value;
}

function candidateIds(candidates: readonly ExternalSessionCandidateV1[]): string[] {
  return candidates.map((candidate) => candidate.remoteSessionId);
}

function expectStableUniqueCandidateSet(
  fixture: NativeFixture,
  first: readonly ExternalSessionCandidateV1[],
  second: readonly ExternalSessionCandidateV1[],
): void {
  const firstIds = candidateIds(first);
  const secondIds = candidateIds(second);
  expect(secondIds).toEqual(firstIds);
  expect(new Set(firstIds).size).toBe(firstIds.length);
  expect(new Set(firstIds)).toEqual(new Set(fixture.allRemoteSessionIds));
}

async function prepareAntigravityFixture(testDir: string): Promise<NativeFixture> {
  const home = resolve(join(testDir, 'antigravity-home'));
  const brainDir = resolve(join(home, '.gemini', 'antigravity-cli', 'brain'));
  const primaryRemoteSessionId = 'antigravity-configured-primary';
  const secondaryRemoteSessionId = 'antigravity-configured-secondary';
  const primaryTranscript = join(
    brainDir,
    primaryRemoteSessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
  const secondaryTranscript = join(
    brainDir,
    secondaryRemoteSessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
  await mkdir(resolve(join(primaryTranscript, '..')), { recursive: true });
  await mkdir(resolve(join(secondaryTranscript, '..')), { recursive: true });
  await writeFile(primaryTranscript, [
    jsonl({
      step_index: 1,
      type: 'USER_INPUT',
      text: 'antigravity configured source primary prompt',
      created_at: '2026-08-25T10:00:00.000Z',
    }),
    jsonl({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      text: 'ANTIGRAVITY_CONFIGURED_SOURCE_MARKER',
      created_at: '2026-08-25T10:00:01.000Z',
    }),
  ].join(''), 'utf8');
  await writeFile(secondaryTranscript, [
    jsonl({
      step_index: 1,
      type: 'USER_INPUT',
      text: 'antigravity configured source secondary prompt',
      created_at: '2026-08-25T10:10:00.000Z',
    }),
  ].join(''), 'utf8');
  const canonicalBrainDir = await realpath(brainDir);

  return {
    label: 'Antigravity',
    agentId: 'antigravity',
    source: { kind: 'antigravityCliPrint' },
    primaryRemoteSessionId,
    allRemoteSessionIds: [primaryRemoteSessionId, secondaryRemoteSessionId],
    transcriptMarker: 'ANTIGRAVITY_CONFIGURED_SOURCE_MARKER',
    assertProjectedSource(source) {
      const record = requireRecord(source, 'Antigravity projected source');
      expect(record).toEqual(expect.objectContaining({
        kind: 'antigravityCliPrint',
        brainDir: canonicalBrainDir,
        conversationId: primaryRemoteSessionId,
      }));
    },
  };
}

async function prepareOhMyPiFixture(testDir: string): Promise<NativeFixture> {
  const agentDir = resolve(join(testDir, 'oh-my-pi-agent'));
  const sessionRoot = join(agentDir, 'sessions', '-configured-workspace-');
  const primaryRemoteSessionId = 'oh-my-pi-configured-primary';
  const secondaryRemoteSessionId = 'oh-my-pi-configured-secondary';
  const primarySessionFile = join(
    sessionRoot,
    `2026-08-25T10-00-00-000Z_${primaryRemoteSessionId}.jsonl`,
  );
  const secondarySessionFile = join(
    sessionRoot,
    `2026-08-25T10-10-00-000Z_${secondaryRemoteSessionId}.jsonl`,
  );
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(primarySessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: primaryRemoteSessionId,
      timestamp: '2026-08-25T10:00:00.000Z',
      cwd: '/workspace/oh-my-pi-configured-primary',
      title: 'Oh My Pi configured primary',
    }),
    jsonl({
      type: 'message',
      id: 'oh-my-pi-configured-primary-user',
      parentId: null,
      timestamp: '2026-08-25T10:00:01.000Z',
      message: { role: 'user', content: 'OH_MY_PI_CONFIGURED_SOURCE_MARKER' },
    }),
  ].join(''), 'utf8');
  await writeFile(secondarySessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: secondaryRemoteSessionId,
      timestamp: '2026-08-25T10:10:00.000Z',
      cwd: '/workspace/oh-my-pi-configured-secondary',
      title: 'Oh My Pi configured secondary',
    }),
    jsonl({
      type: 'message',
      id: 'oh-my-pi-configured-secondary-user',
      parentId: null,
      timestamp: '2026-08-25T10:10:01.000Z',
      message: { role: 'user', content: 'oh my pi configured secondary prompt' },
    }),
  ].join(''), 'utf8');
  const canonicalAgentDir = await realpath(agentDir);
  const canonicalPrimarySessionFile = await realpath(primarySessionFile);

  return {
    label: 'Oh My Pi',
    agentId: 'ohMyPi',
    source: { kind: 'ohMyPiAgentDir', agentDir: canonicalAgentDir },
    primaryRemoteSessionId,
    allRemoteSessionIds: [primaryRemoteSessionId, secondaryRemoteSessionId],
    transcriptMarker: 'OH_MY_PI_CONFIGURED_SOURCE_MARKER',
    agentDir: canonicalAgentDir,
    assertProjectedSource(source) {
      const record = requireRecord(source, 'Oh My Pi projected source');
      expect(record).toEqual(expect.objectContaining({
        kind: 'ohMyPiAgentDir',
        agentDir: canonicalAgentDir,
        sessionFilePath: canonicalPrimarySessionFile,
      }));
    },
  };
}

async function preparePiFixture(testDir: string): Promise<NativeFixture> {
  const agentDir = resolve(join(testDir, 'pi-agent'));
  const sessionRoot = join(agentDir, 'sessions', '--configured-workspace--');
  const primaryRemoteSessionId = 'pi-configured-primary';
  const secondaryRemoteSessionId = 'pi-configured-secondary';
  const primarySessionFile = join(
    sessionRoot,
    `2026-08-25T10-00-00-000Z_${primaryRemoteSessionId}.jsonl`,
  );
  const secondarySessionFile = join(
    sessionRoot,
    `2026-08-25T10-10-00-000Z_${secondaryRemoteSessionId}.jsonl`,
  );
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(primarySessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: primaryRemoteSessionId,
      timestamp: '2026-08-25T10:00:00.000Z',
      cwd: '/workspace/pi-configured-primary',
    }),
    jsonl({
      type: 'message',
      id: 'pi-configured-primary-user',
      parentId: null,
      timestamp: '2026-08-25T10:00:01.000Z',
      message: { role: 'user', content: 'PI_CONFIGURED_SOURCE_MARKER' },
    }),
    jsonl({
      type: 'session_info',
      id: 'pi-configured-primary-title',
      parentId: 'pi-configured-primary-user',
      timestamp: '2026-08-25T10:00:02.000Z',
      name: 'Pi configured primary',
    }),
  ].join(''), 'utf8');
  await writeFile(secondarySessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: secondaryRemoteSessionId,
      timestamp: '2026-08-25T10:10:00.000Z',
      cwd: '/workspace/pi-configured-secondary',
    }),
    jsonl({
      type: 'message',
      id: 'pi-configured-secondary-user',
      parentId: null,
      timestamp: '2026-08-25T10:10:01.000Z',
      message: { role: 'user', content: 'pi configured secondary prompt' },
    }),
  ].join(''), 'utf8');
  const canonicalAgentDir = await realpath(agentDir);
  const canonicalPrimarySessionFile = await realpath(primarySessionFile);

  return {
    label: 'Pi',
    agentId: 'pi',
    source: { kind: 'piAgentDir', agentDir: canonicalAgentDir },
    primaryRemoteSessionId,
    allRemoteSessionIds: [primaryRemoteSessionId, secondaryRemoteSessionId],
    transcriptMarker: 'PI_CONFIGURED_SOURCE_MARKER',
    agentDir: canonicalAgentDir,
    assertProjectedSource(source) {
      const record = requireRecord(source, 'Pi projected source');
      expect(record).toEqual(expect.objectContaining({
        kind: 'piAgentDir',
        agentDir: canonicalAgentDir,
        sessionFile: canonicalPrimarySessionFile,
      }));
    },
  };
}

async function preparePiExactFileFixture(testDir: string): Promise<PiExactFileFixture> {
  const agentDir = resolve(join(testDir, 'pi-exact-file-agent'));
  const selectedSessionFile = join(
    agentDir,
    'sessions',
    'workspace-selected',
    'pi-shared.jsonl',
  );
  const siblingSessionFile = join(
    agentDir,
    'sessions',
    'workspace-sibling',
    'pi-shared.jsonl',
  );
  const targetDirectory = resolve(join(testDir, 'pi-exact-file-target-directory'));
  const linkedDirectory = resolve(join(testDir, 'pi-exact-file-provider-directory'));
  await Promise.all([
    mkdir(resolve(join(selectedSessionFile, '..')), { recursive: true }),
    mkdir(resolve(join(siblingSessionFile, '..')), { recursive: true }),
    mkdir(linkedDirectory, { recursive: true }),
    mkdir(targetDirectory, { recursive: true }),
  ]);
  await writeFile(selectedSessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: 'pi-shared',
      timestamp: '2026-08-25T11:00:00.000Z',
      cwd: linkedDirectory,
    }),
    jsonl({
      type: 'message',
      id: 'pi-exact-file-selected-user',
      parentId: null,
      timestamp: '2026-08-25T11:00:01.000Z',
      message: { role: 'user', content: 'PI_EXACT_FILE_SELECTED_MARKER' },
    }),
  ].join(''), 'utf8');
  await writeFile(siblingSessionFile, [
    jsonl({
      type: 'session',
      version: 3,
      id: 'pi-shared',
      timestamp: '2026-08-25T11:10:00.000Z',
      cwd: '/workspace/pi-sibling',
    }),
    jsonl({
      type: 'message',
      id: 'pi-exact-file-sibling-user',
      parentId: null,
      timestamp: '2026-08-25T11:10:01.000Z',
      message: { role: 'user', content: 'PI_EXACT_FILE_SIBLING_MARKER' },
    }),
  ].join(''), 'utf8');
  const [canonicalAgentDir, canonicalSelectedSessionFile, canonicalSiblingSessionFile] = await Promise.all([
    realpath(agentDir),
    realpath(selectedSessionFile),
    realpath(siblingSessionFile),
  ]);
  const fixture: NativeFixture = {
    label: 'Pi exact-file duplicate-ID',
    agentId: 'pi',
    source: { kind: 'piAgentDir', agentDir: canonicalAgentDir },
    primaryRemoteSessionId: 'pi-shared',
    // The leaf intentionally exposes both physical files. The caller below
    // asserts stable, duplicate-free physical candidate identities before
    // selecting the link-data file explicitly.
    allRemoteSessionIds: ['pi-shared', 'pi-shared'],
    transcriptMarker: 'PI_EXACT_FILE_SELECTED_MARKER',
    agentDir: canonicalAgentDir,
    assertProjectedSource(source) {
      const record = requireRecord(source, 'Pi exact-file projected source');
      expect(record).toEqual(expect.objectContaining({
        kind: 'piAgentDir',
        agentDir: canonicalAgentDir,
        sessionFile: canonicalSelectedSessionFile,
      }));
    },
  };
  return {
    fixture,
    agentDir: canonicalAgentDir,
    selectedSessionFile: canonicalSelectedSessionFile,
    siblingSessionFile: canonicalSiblingSessionFile,
    linkedDirectory,
    targetDirectory,
  };
}

async function writeFakePiExecutable(params: Readonly<{
  binDir: string;
  capturePath: string;
}>): Promise<void> {
  const agentScriptPath = join(params.binDir, 'pi-agent.cjs');
  const agentSource = `
const { writeFileSync } = require('node:fs');

const capturePath = ${JSON.stringify(params.capturePath)};
let buffer = '';
const commands = [];
const capture = () => writeFileSync(capturePath, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  commands,
}));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
capture();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    commands.push(request.type);
    capture();
    const data = request.type === 'get_commands'
      ? { commands: [] }
      : request.type === 'get_state'
        ? { sessionId: 'pi-shared', isStreaming: false, isCompacting: false }
        : undefined;
    send({
      type: 'response',
      id: request.id,
      command: request.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  }
});
`;
  await writeFile(agentScriptPath, agentSource, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(
      join(params.binDir, 'pi.cmd'),
      `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`,
      'utf8',
    );
    return;
  }
  const executablePath = join(params.binDir, 'pi');
  await writeFile(executablePath, `#!/usr/bin/env node\n${agentSource}`, 'utf8');
  await chmod(executablePath, 0o755);
}

async function readFakePiCapture(capturePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(capturePath, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return requireRecord(JSON.parse(raw), 'fake Pi capture');
  } catch {
    return null;
  }
}

function candidatePhysicalIdentity(candidate: ExternalSessionCandidateV1): string {
  const sessionFile = typeof candidate.linkData?.sessionFile === 'string'
    ? candidate.linkData.sessionFile
    : '';
  return `${candidate.remoteSessionId}\u0000${sessionFile}`;
}

async function waitForCandidates(params: Readonly<{
  client: DataKeyRpcClient;
  machineId: string;
  fixture: NativeFixture;
}>): Promise<readonly ExternalSessionCandidateV1[]> {
  let candidates: readonly ExternalSessionCandidateV1[] | null = null;
  await waitFor(async () => {
    const response = await params.client.call(
      `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`,
      {
        machineId: params.machineId,
        agentId: params.fixture.agentId,
        source: params.fixture.source,
        limit: 20,
      },
    );
    if (!response.ok) return false;
    const parsed = ExternalSessionsCandidatesListResponseSchema.parse(
      unwrapDataKeyRpcResult(response, `${params.fixture.label} candidates`),
    );
    if (!parsed.ok) {
      throw new Error(
        `${params.fixture.label} candidates failed: ${parsed.errorCode}/${parsed.error}`,
      );
    }
    candidates = parsed.candidates;
    return !parsed.preparation
      && params.fixture.allRemoteSessionIds.every((id) =>
        parsed.candidates.some((candidate) => candidate.remoteSessionId === id));
  }, {
    timeoutMs: 30_000,
    context: `${params.fixture.label} configured-source candidates available`,
  });
  if (!candidates) throw new Error(`Expected ${params.fixture.label} candidates.`);
  return candidates;
}

async function linkFixture(params: Readonly<{
  client: DataKeyRpcClient;
  machineId: string;
  baseUrl: string;
  token: string;
  machineKey: Uint8Array;
  fixture: NativeFixture;
  candidate: ExternalSessionCandidateV1;
  directoryHint?: string;
}>): Promise<LinkedFixture> {
  if (!params.candidate.linkData) {
    throw new Error(`Expected ${params.fixture.label} candidate link data.`);
  }
  const request = {
    machineId: params.machineId,
    agentId: params.fixture.agentId,
    remoteSessionId: params.fixture.primaryRemoteSessionId,
    source: params.fixture.source,
    linkData: params.candidate.linkData,
    ...(params.directoryHint ? { directoryHint: params.directoryHint } : {}),
  };
  const firstResponse = await params.client.call(
    `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`,
    request,
  );
  const first = ExternalSessionLinkEnsureResponseSchema.parse(
    unwrapDataKeyRpcResult(firstResponse, `${params.fixture.label} first link`),
  );
  if (!first.ok) {
    throw new Error(`${params.fixture.label} first link failed: ${first.errorCode}/${first.error}`);
  }
  expect(first.created).toBe(true);

  const secondResponse = await params.client.call(
    `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`,
    request,
  );
  const second = ExternalSessionLinkEnsureResponseSchema.parse(
    unwrapDataKeyRpcResult(secondResponse, `${params.fixture.label} idempotent link`),
  );
  if (!second.ok) {
    throw new Error(`${params.fixture.label} idempotent link failed: ${second.errorCode}/${second.error}`);
  }
  expect(second).toEqual(expect.objectContaining({
    created: false,
    sessionId: first.sessionId,
  }));

  const metadata = await fetchSessionMetadataV2({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: first.sessionId,
    machineKeys: [params.machineKey],
  });
  const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  if (!linked) throw new Error(`Expected ${params.fixture.label} linked session metadata.`);
  expect(linked).toEqual(expect.objectContaining({
    agentId: params.fixture.agentId,
    remoteSessionId: params.fixture.primaryRemoteSessionId,
    machineId: params.machineId,
  }));
  params.fixture.assertProjectedSource(linked.source);

  return {
    fixture: params.fixture,
    candidate: params.candidate,
    sessionId: first.sessionId,
    source: linked.source,
  };
}

async function expectStableNonEmptyTranscript(params: Readonly<{
  client: DataKeyRpcClient;
  machineId: string;
  linked: LinkedFixture;
}>): Promise<void> {
  const request = {
    machineId: params.machineId,
    agentId: params.linked.fixture.agentId,
    remoteSessionId: params.linked.fixture.primaryRemoteSessionId,
    source: params.linked.source,
    direction: 'older' as const,
    maxBytes: 64 * 1024,
    maxItems: 50,
  };
  const readPage = async () => {
    const response = await params.client.call(
      `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE}`,
      request,
    );
    const parsed = ExternalSessionTranscriptPageResponseSchema.parse(
      unwrapDataKeyRpcResult(response, `${params.linked.fixture.label} transcript page`),
    );
    if (!parsed.ok) {
      throw new Error(
        `${params.linked.fixture.label} transcript page failed: ${parsed.errorCode}/${parsed.error}`,
      );
    }
    return parsed;
  };
  const first = await readPage();
  const second = await readPage();
  const firstIds = first.items.map((item) => item.id);
  const secondIds = second.items.map((item) => item.id);
  expect(first.items.length).toBeGreaterThan(0);
  expect(new Set(firstIds).size).toBe(firstIds.length);
  expect(secondIds).toEqual(firstIds);
  expect(JSON.stringify(first.items)).toContain(params.linked.fixture.transcriptMarker);
}

async function expectOhMyPiReconcileOnlyDiscontinuity(params: Readonly<{
  client: DataKeyRpcClient;
  machineId: string;
  linked: LinkedFixture;
}>): Promise<void> {
  const response = await params.client.call(
    `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET}`,
    {
      machineId: params.machineId,
      sessionId: params.linked.sessionId,
      agentId: params.linked.fixture.agentId,
      remoteSessionId: params.linked.fixture.primaryRemoteSessionId,
      source: params.linked.source,
      enabled: true,
    },
  );
  const parsed = ExternalSessionFollowPolicySetResponseSchema.parse(
    unwrapDataKeyRpcResult(response, 'Oh My Pi reconcile-only follow request'),
  );
  expect(parsed).toEqual(expect.objectContaining({
    ok: false,
    errorCode: 'agent_unavailable',
    error: 'background_follow_not_supported',
  }));
}

async function expectReconnectRelink(params: Readonly<{
  client: DataKeyRpcClient;
  machineId: string;
  linked: LinkedFixture;
}>): Promise<void> {
  await waitFor(async () => {
    const response = await params.client.call(
      `${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`,
      {
        machineId: params.machineId,
        agentId: params.linked.fixture.agentId,
        remoteSessionId: params.linked.fixture.primaryRemoteSessionId,
        source: params.linked.fixture.source,
        linkData: params.linked.candidate.linkData,
      },
    );
    if (!response.ok) return false;
    const parsed = ExternalSessionLinkEnsureResponseSchema.parse(
      unwrapDataKeyRpcResult(response, `${params.linked.fixture.label} reconnect relink`),
    );
    if (!parsed.ok) {
      throw new Error(
        `${params.linked.fixture.label} reconnect relink failed: ${parsed.errorCode}/${parsed.error}`,
      );
    }
    return parsed.created === false && parsed.sessionId === params.linked.sessionId;
  }, {
    timeoutMs: 30_000,
    context: `${params.linked.fixture.label} relinks after daemon/socket reconnect`,
  });
}

describe('core e2e: configured native-Agent external-session sources', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;

  afterEach(async () => {
    ui?.close();
    ui = null;
    const cleanupErrors: Error[] = [];
    await daemon?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    daemon = null;
    await retiredDaemon?.proc.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    retiredDaemon = null;
    await server?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    server = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Native Agent configured-source e2e teardown failed');
    }
  });

  afterAll(async () => {
    ui?.close();
    await daemon?.stop().catch(() => {});
    await retiredDaemon?.proc.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('projects configured sources through discover, idempotent link, transcript, reconcile-only OMP, and daemon/socket reconnect', async () => {
    const testDir = run.testDir('external-sessions-native-agent-configured-sources');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const ambientPiAgentDir = resolve(join(testDir, 'ambient-pi-agent'));
    const [antigravity, ohMyPi, pi] = await Promise.all([
      prepareAntigravityFixture(testDir),
      prepareOhMyPiFixture(testDir),
      preparePiFixture(testDir),
    ]);
    if (!ohMyPi.agentDir || !pi.agentDir) {
      throw new Error('Expected configured Oh My Pi and Pi fixture directories.');
    }
    await Promise.all([
      mkdir(daemonHomeDir, { recursive: true }),
      mkdir(ambientPiAgentDir, { recursive: true }),
      mkdir(resolve(join(testDir, 'xdg-config')), { recursive: true }),
    ]);

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      material: { type: 'dataKey', machineKey: auth.accountMachineKey },
      settings: accountSettingsParse({
        ohMyPiAgentDir: ohMyPi.agentDir,
        piAgentDir: pi.agentDir,
      }),
    });
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
      HOME: resolve(join(testDir, 'antigravity-home')),
      USERPROFILE: resolve(join(testDir, 'antigravity-home')),
      XDG_CONFIG_HOME: resolve(join(testDir, 'xdg-config')),
      // Both Pi-family requests carry their account-materialized root. An empty
      // ambient store makes this row fail if the daemon silently falls back to it.
      PI_CODING_AGENT_DIR: ambientPiAgentDir,
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: 90_000,
      env: daemonEnv,
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), {
      timeoutMs: 20_000,
      context: 'socket connected for configured native-Agent external sessions',
    });
    let client = createDataKeyRpcClient(ui, auth.accountMachineKey);
    const fixtures = [antigravity, ohMyPi, pi] as const;
    const linked: LinkedFixture[] = [];

    for (const fixture of fixtures) {
      const firstCandidates = await waitForCandidates({
        client,
        machineId: seeded.machineId,
        fixture,
      });
      const secondCandidates = await waitForCandidates({
        client,
        machineId: seeded.machineId,
        fixture,
      });
      expectStableUniqueCandidateSet(fixture, firstCandidates, secondCandidates);
      const primary = firstCandidates.find(
        (candidate) => candidate.remoteSessionId === fixture.primaryRemoteSessionId,
      );
      if (!primary) throw new Error(`Expected ${fixture.label} primary candidate.`);
      const linkedFixture = await linkFixture({
        client,
        machineId: seeded.machineId,
        baseUrl: server.baseUrl,
        token: auth.token,
        machineKey: auth.accountMachineKey,
        fixture,
        candidate: primary,
      });
      await expectStableNonEmptyTranscript({
        client,
        machineId: seeded.machineId,
        linked: linkedFixture,
      });
      linked.push(linkedFixture);
    }

    const ohMyPiLinked = linked.find((fixture) => fixture.fixture.agentId === 'ohMyPi');
    if (!ohMyPiLinked) throw new Error('Expected linked Oh My Pi fixture.');
    await expectOhMyPiReconcileOnlyDiscontinuity({
      client,
      machineId: seeded.machineId,
      linked: ohMyPiLinked,
    });

    const originalDaemonPid = daemon.state.pid;
    const replacement = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemon,
    });
    retiredDaemon = daemon;
    daemon = replacement;
    expect(replacement.state.pid).not.toBe(originalDaemonPid);

    ui.close();
    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), {
      timeoutMs: 20_000,
      context: 'socket reconnect after configured native-Agent daemon replacement',
    });
    client = createDataKeyRpcClient(ui, auth.accountMachineKey);
    for (const linkedFixture of linked) {
      await expectReconnectRelink({
        client,
        machineId: seeded.machineId,
        linked: linkedFixture,
      });
      await expectStableNonEmptyTranscript({
        client,
        machineId: seeded.machineId,
        linked: linkedFixture,
      });
    }
  }, 180_000);

  it('takes over the explicitly linked Pi file when two configured files share its native id', async () => {
    const testDir = run.testDir('external-sessions-pi-exact-file-takeover');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const ambientPiAgentDir = resolve(join(testDir, 'ambient-pi-agent'));
    const fakePiBinDir = resolve(join(testDir, 'fake-pi-bin'));
    const fakePiCapturePath = join(testDir, 'fake-pi-capture.json');
    const exactFile = await preparePiExactFileFixture(testDir);
    await Promise.all([
      mkdir(daemonHomeDir, { recursive: true }),
      mkdir(ambientPiAgentDir, { recursive: true }),
      mkdir(fakePiBinDir, { recursive: true }),
      mkdir(resolve(join(testDir, 'xdg-config')), { recursive: true }),
    ]);
    await writeFakePiExecutable({ binDir: fakePiBinDir, capturePath: fakePiCapturePath });

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      material: { type: 'dataKey', machineKey: auth.accountMachineKey },
      settings: accountSettingsParse({ piAgentDir: exactFile.agentDir }),
    });
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: 90_000,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
        HOME: resolve(join(testDir, 'home')),
        USERPROFILE: resolve(join(testDir, 'home')),
        XDG_CONFIG_HOME: resolve(join(testDir, 'xdg-config')),
        PATH: `${fakePiBinDir}${delimiter}${process.env.PATH ?? ''}`,
        // The selected configured root must be materialized into the takeover
        // launch. This empty ambient root catches any source-settings bypass.
        PI_CODING_AGENT_DIR: ambientPiAgentDir,
      },
    });

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), {
      timeoutMs: 20_000,
      context: 'socket connected for Pi exact-file takeover',
    });
    const client = createDataKeyRpcClient(ui, auth.accountMachineKey);
    const firstCandidates = await waitForCandidates({
      client,
      machineId: seeded.machineId,
      fixture: exactFile.fixture,
    });
    const secondCandidates = await waitForCandidates({
      client,
      machineId: seeded.machineId,
      fixture: exactFile.fixture,
    });
    const firstPhysicalIdentities = firstCandidates.map(candidatePhysicalIdentity);
    expect(secondCandidates.map(candidatePhysicalIdentity)).toEqual(firstPhysicalIdentities);
    expect(new Set(firstPhysicalIdentities).size).toBe(firstPhysicalIdentities.length);
    const selectedCandidate = firstCandidates.find((candidate) => (
      candidate.remoteSessionId === exactFile.fixture.primaryRemoteSessionId
      && candidate.linkData?.sessionFile === exactFile.selectedSessionFile
    ));
    if (!selectedCandidate) {
      throw new Error('Expected the selected physical Pi duplicate-ID candidate.');
    }
    const siblingCandidate = firstCandidates.find((candidate) => (
      candidate.remoteSessionId === exactFile.fixture.primaryRemoteSessionId
      && candidate.linkData?.sessionFile === exactFile.siblingSessionFile
    ));
    if (!siblingCandidate) {
      throw new Error('Expected the sibling physical Pi duplicate-ID candidate.');
    }
    expect(selectedCandidate.linkData?.sessionFile).toBe(exactFile.selectedSessionFile);
    expect(selectedCandidate.linkData?.sessionFile).not.toBe(exactFile.siblingSessionFile);

    const linked = await linkFixture({
      client,
      machineId: seeded.machineId,
      baseUrl: server.baseUrl,
      token: auth.token,
      machineKey: auth.accountMachineKey,
      fixture: exactFile.fixture,
      candidate: selectedCandidate,
      directoryHint: exactFile.linkedDirectory,
    });
    await expectStableNonEmptyTranscript({
      client,
      machineId: seeded.machineId,
      linked,
    });

    const metadata = await fetchSessionMetadataV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: linked.sessionId,
      machineKeys: [auth.accountMachineKey],
    });
    const linkedMetadata = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
    if (!linkedMetadata?.qualifiedIdentity) {
      throw new Error('Expected canonical Pi exact-file qualified identity.');
    }
    const takeoverRequest = {
      v: 1 as const,
      idempotencyKey: `pi-exact-file-takeover-${randomUUID()}`,
      sessionId: linked.sessionId,
      source: {
        machineId: seeded.machineId,
        remoteSessionId: exactFile.fixture.primaryRemoteSessionId,
        qualifiedIdentity: linkedMetadata.qualifiedIdentity,
        linkGeneration: String(linkedMetadata.linkedAtMs),
      },
      plan: 'takeover' as const,
      targetStorageMode: 'persisted' as const,
      targetDirectory: exactFile.targetDirectory,
      targetRuntimeMode: 'terminal' as const,
    };
    const start = await client.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START}`,
      { request: takeoverRequest },
      180_000,
    );
    const startResult = requireRecord(
      unwrapDataKeyRpcResult(start, 'Pi exact-file takeover start'),
      'Pi exact-file takeover start',
    );
    expect(startResult).toEqual(expect.objectContaining({
      ok: true,
      progress: expect.objectContaining({
        status: 'awaiting_user_resume',
        phase: 'validating',
        currentStorageState: 'machine_only',
      }),
    }));
    const startProgress = requireRecord(startResult.progress, 'Pi exact-file start progress');
    const operationId = requireString(startProgress.operationId, 'Pi exact-file operation id');
    const startRevision = requireNumber(startProgress.revision, 'Pi exact-file start revision');

    const importResume = await client.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME}`,
      { sessionId: linked.sessionId, operationId, revision: startRevision },
      180_000,
    );
    const importResumeResult = requireRecord(
      unwrapDataKeyRpcResult(importResume, 'Pi exact-file import resume'),
      'Pi exact-file import resume',
    );
    expect(importResumeResult).toEqual(expect.objectContaining({
      ok: true,
      progress: expect.objectContaining({
        operationId,
        status: 'awaiting_user_resume',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
      }),
    }));
    const importProgress = requireRecord(
      importResumeResult.progress,
      'Pi exact-file import progress',
    );
    const importRevision = requireNumber(importProgress.revision, 'Pi exact-file import revision');
    expect(importRevision).toBeGreaterThan(startRevision);

    const admissionResume = await client.call(
      `${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME}`,
      { sessionId: linked.sessionId, operationId, revision: importRevision },
      180_000,
    );
    const admissionResumeResult = requireRecord(
      unwrapDataKeyRpcResult(admissionResume, 'Pi exact-file admission resume'),
      'Pi exact-file admission resume',
    );
    expect(admissionResumeResult).toEqual(expect.objectContaining({
      ok: true,
      progress: expect.objectContaining({
        operationId,
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
      }),
    }));

    await waitFor(async () => {
      const capture = await readFakePiCapture(fakePiCapturePath);
      if (!capture) return false;
      const args = requireStringArray(capture.args, 'fake Pi args');
      const sessionFlagIndex = args.lastIndexOf('--session');
      return sessionFlagIndex >= 0 && args[sessionFlagIndex + 1] === exactFile.selectedSessionFile;
    }, {
      timeoutMs: 45_000,
      context: 'Pi takeover starts the selected exact native session file',
    });
    const capture = await readFakePiCapture(fakePiCapturePath);
    if (!capture) throw new Error('Expected fake Pi process capture after takeover admission.');
    const args = requireStringArray(capture.args, 'fake Pi args');
    const sessionFlagIndex = args.lastIndexOf('--session');
    expect(sessionFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[sessionFlagIndex + 1]).toBe(exactFile.selectedSessionFile);
    expect(args).not.toContain(exactFile.siblingSessionFile);
    expect(exactFile.targetDirectory).not.toBe(exactFile.linkedDirectory);
    expect(capture).toEqual(expect.objectContaining({
      cwd: exactFile.targetDirectory,
      piAgentDir: exactFile.agentDir,
    }));
    expect(capture.cwd).not.toBe(exactFile.linkedDirectory);
  }, 180_000);
});
