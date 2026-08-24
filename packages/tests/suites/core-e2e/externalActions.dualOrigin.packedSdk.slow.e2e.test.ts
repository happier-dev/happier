import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
  EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
  TargetActionApprovalRequestV1Schema,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_CHANGE_REQUEST_PATH } from '../../../../apps/cli/src/plugins/daemon/controlRoutes';
import { packLocalPlugin } from '../../../../apps/cli/src/plugins/packaging/pack';
import { exportPackSandboxTarball } from '../../../../apps/stack/scripts/pack.mjs';
import {
  decodeEncryptedArtifactJsonBase64ForCliAccessKey,
  fetchArtifactViaApi,
  listArtifactsViaApi,
  updateEncryptedArtifactViaApi,
  type ArtifactRecord,
} from '../../src/testkit/artifactApi';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { readCliAccessKey, type CliAccessKey } from '../../src/testkit/cliAccessKey';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  createLocalExtensionPackageManifest,
  createPluginActionContribution,
  writeLocalExtensionPackageFixture,
} from '../../src/testkit/extensions/localPackageFixture';
import { buildPreAttestedExternalSessionLiveEnv } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { decideAuthenticatedPluginInstallReview } from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import {
  resolveCliTestLaunchSpec,
  type CliTestLaunchSpec,
} from '../../src/testkit/process/cliLaunchSpec';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  runLoggedCommand,
  spawnLoggedProcess,
  type SpawnedProcess,
} from '../../src/testkit/process/spawnProcess';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

const PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS = 300;
const PACKED_SDK_SESSION_IDLE_WAITS_PER_FLOW = 2;
const PACKED_SDK_SESSION_FLOW_DRIVER_HEADROOM_MS = 30_000;
const PACKED_SDK_SESSION_FLOW_DRIVER_TIMEOUT_MS = (
  PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS * PACKED_SDK_SESSION_IDLE_WAITS_PER_FLOW * 1_000
) + PACKED_SDK_SESSION_FLOW_DRIVER_HEADROOM_MS;
const LIVE_SESSION_FLOW_COUNT = 5;
const DUAL_ORIGIN_E2E_NON_SESSION_HEADROOM_MS = 300_000;
const DUAL_ORIGIN_E2E_TIMEOUT_MS = (
  PACKED_SDK_SESSION_FLOW_DRIVER_TIMEOUT_MS * LIVE_SESSION_FLOW_COUNT
) + DUAL_ORIGIN_E2E_NON_SESSION_HEADROOM_MS;

const EXTERNAL_PLUGIN_ID = 'acme.external-action-live';
const EXTERNAL_ACTION_LOCAL_ID = 'inspect';
const EXTERNAL_ACTION_ID = `${EXTERNAL_PLUGIN_ID}/actions/${EXTERNAL_ACTION_LOCAL_ID}`;

type ExternalSdkDriverRequest =
  | Readonly<{
    endpoint: string;
    machineId: string;
    operation: 'invoke';
    input?: unknown;
  }>
  | Readonly<{
    endpoint: string;
    machineId: string;
    operation: 'search';
    query: string;
  }>
  | Readonly<{
    endpoint: string;
    machineId?: string;
    operation: 'sessionFlow';
    fakeClaudeInvocationId: string;
    fakeClaudeLogPath: string;
    fakeClaudePath: string;
    fakeClaudeSessionId: string;
    followUpMessage: string;
    initialMessage: string;
    workspaceDir: string;
  }>
  | Readonly<{
    endpoint: string;
    machineId: string;
    operation: 'sessionStatus';
    sessionId: string;
  }>;

type ExternalSdkDriverResult = Readonly<{
  ok: boolean;
  code?: string;
  status?: number;
  result?: unknown;
}>;

type PackedSdkConsumer = Readonly<{
  consumerDir: string;
  driverPath: string;
  logPaths: string[];
  sdkCandidateTarballPath: string | null;
}>;

type FakeClaudeSessionTurnSentinel = Readonly<{
  fakeClaudeInvocationId: string;
  fakeClaudeSessionId: string;
  followUpMessage: string;
  initialMessage: string;
}>;

type PackedSdkRunStreamProbe = Readonly<{
  cancelled: true;
  firstEventType: string;
  runId: string;
  streamId: string;
}>;

type FirstClassCliSessionFlowResult = Readonly<{
  logPaths: readonly string[];
  sessionId: string;
  transcript: unknown;
}>;

type OpenTargetActionApproval = Readonly<{
  artifact: ArtifactRecord;
  request: TargetActionApprovalRequestV1;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected non-empty ${context}`);
  }
  return value.trim();
}

function parseJsonRecords(raw: string): Readonly<Record<string, unknown>>[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    })
    .map(asRecord)
    .filter((value): value is Readonly<Record<string, unknown>> => value !== null);
}

function parseSingleJsonRecord(raw: string, context: string): Readonly<Record<string, unknown>> {
  const text = raw.trim();
  if (!text) throw new Error(`${context} did not emit a JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${context} did not emit exactly one JSON object`);
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(`${context} did not emit a JSON object`);
  return record;
}

function parseExternalSdkDriverResult(raw: string): ExternalSdkDriverResult {
  const parsed = parseSingleJsonRecord(raw, 'Packed SDK driver');
  if (typeof parsed.ok !== 'boolean') throw new Error('Packed SDK driver did not emit a valid result');
  return {
    ok: parsed.ok,
    ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
    ...(typeof parsed.status === 'number' && Number.isInteger(parsed.status)
      ? { status: parsed.status }
      : {}),
    ...(Object.hasOwn(parsed, 'result') ? { result: parsed.result } : {}),
  };
}

function resolveReleaseValidationSdkTarball(): string | null {
  const tarballPath = process.env.HAPPIER_RELEASE_VALIDATION_SDK_TARBALL?.trim() ?? '';
  if (!tarballPath) return null;
  if (!isAbsolute(tarballPath) || !tarballPath.endsWith('.tgz')) {
    throw new Error('HAPPIER_RELEASE_VALIDATION_SDK_TARBALL must be an absolute .tgz path');
  }
  return resolve(tarballPath);
}

function externalConsumerEnv(params: Readonly<{
  endpoint: string;
  token: string;
  machineId?: string;
  workspaceDir?: string;
}>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAPPIER_API_ENDPOINT: params.endpoint,
    HAPPIER_TOKEN: params.token,
  };
  // The consumer has no daemon configuration. The server-origin flow must
  // discover its target through the public Account endpoint instead.
  delete env.HAPPIER_HOME_DIR;
  delete env.HAPPIER_SERVER_URL;
  delete env.HAPPIER_WEBAPP_URL;
  delete env.HAPPIER_MACHINE_ID;
  delete env.HAPPIER_API_TOKEN;
  delete env.HAPPIER_AGENT_ID;
  delete env.HAPPIER_AGENT_PLUGIN_ID;
  delete env.HAPPIER_AGENT_LOCAL_ID;
  delete env.HAPPIER_CLAUDE_PATH;
  delete env.HAPPIER_E2E_FAKE_CLAUDE_LOG;
  delete env.HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID;
  delete env.HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID;
  delete env.HAPPY_CLAUDE_PATH;
  delete env.HAPPY_E2E_FAKE_CLAUDE_LOG;
  delete env.HAPPY_E2E_FAKE_CLAUDE_INVOCATION_ID;
  delete env.HAPPY_E2E_FAKE_CLAUDE_SESSION_ID;
  if (params.machineId) env.HAPPIER_MACHINE_ID = params.machineId;
  if (params.workspaceDir) {
    env.HAPPIER_WORKSPACE_PATH = params.workspaceDir;
    env.HAPPIER_AGENT_ID = 'claude';
  }
  return env;
}

async function writePackedSdkDriver(params: Readonly<{ consumerDir: string }>): Promise<string> {
  const driverPath = resolve(join(params.consumerDir, 'external-sdk-driver.mjs'));
  await writeFile(driverPath, [
    'import { connect } from "@happier-dev/sdk";',
    '',
    'const request = JSON.parse(process.env.HAPPIER_E2E_SDK_DRIVER_REQUEST ?? "{}");',
    'const token = process.env.HAPPIER_TOKEN;',
    'if (typeof request.endpoint !== "string" || typeof token !== "string") {',
    '  throw new Error("invalid_sdk_driver_environment");',
    '}',
    'const account = connect({ endpoint: request.endpoint, token });',
    'try {',
    '  const requireMachineId = () => {',
    '    if (typeof request.machineId !== "string" || request.machineId.trim().length === 0) {',
    '      throw new Error("missing_sdk_driver_machine_id");',
    '    }',
    '    return request.machineId;',
    '  };',
    '  const discoverMachineId = async () => {',
    '    if (typeof request.machineId === "string" && request.machineId.trim().length > 0) {',
    '      return request.machineId;',
    '    }',
    '    const machines = await account.machines.list();',
    '    const selected = machines.find((machine) => (',
    '      machine.active && machine.revokedAt === null && machine.replacedByMachineId === null',
    '    ));',
    '    if (!selected) throw new Error("no_active_machine_available");',
    '    return selected.id;',
    '  };',
    '  let result;',
    '  if (request.operation === "invoke") {',
    `    result = await account.machine(requireMachineId()).actions.invoke({ pluginId: ${JSON.stringify(EXTERNAL_PLUGIN_ID)}, localId: ${JSON.stringify(EXTERNAL_ACTION_LOCAL_ID)} }, request.input ?? {});`,
    '  } else if (request.operation === "search") {',
    '    result = await account.machine(requireMachineId()).actions.search({ query: request.query, limit: 10 });',
    '  } else if (request.operation === "sessionStatus") {',
    '    result = await account.machine(requireMachineId()).actions.execute("session.status.get", { sessionId: request.sessionId, live: false });',
    '  } else if (request.operation === "sessionFlow") {',
    '    const requiredValues = [',
    '      request.workspaceDir,',
    '      request.initialMessage,',
    '      request.followUpMessage,',
    '      request.fakeClaudePath,',
    '      request.fakeClaudeLogPath,',
    '      request.fakeClaudeInvocationId,',
    '      request.fakeClaudeSessionId,',
    '    ];',
    '    if (!requiredValues.every((value) => typeof value === "string" && value.trim().length > 0)) {',
    '      throw new Error("invalid_sdk_driver_session_flow");',
    '    }',
    '    const machine = account.machine(await discoverMachineId());',
    '    const session = await machine.sessions.spawn({',
    '      directory: request.workspaceDir,',
    '      agent: "claude",',
    '      initialMessage: request.initialMessage,',
    '      environmentVariables: {',
    '        // Test controls cross the public spawn boundary; the daemon has none.',
    '        HAPPIER_CLAUDE_PATH: request.fakeClaudePath,',
    '        HAPPIER_E2E_FAKE_CLAUDE_LOG: request.fakeClaudeLogPath,',
    '        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: request.fakeClaudeInvocationId,',
    '        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: request.fakeClaudeSessionId,',
    '      },',
    '    });',
    '    try {',
    `      await session.waitForIdle({ timeoutSeconds: ${PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS} });`,
    '      await session.send(request.followUpMessage);',
    `      await session.waitForIdle({ timeoutSeconds: ${PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS} });`,
    '      const startedRun = await machine.actions.execute("execution.run.start", {',
    '        sessionId: session.id,',
    '        intent: "voice_agent",',
    '        backendTarget: { kind: "backend", backendId: "claude", sourceKind: "built_in" },',
    '        permissionMode: "read_only",',
    '        retentionPolicy: "resumable",',
    '        runClass: "long_lived",',
    '        ioMode: "streaming",',
    '        chatModelId: "packed-sdk-stream-chat",',
    '        commitModelId: "packed-sdk-stream-commit",',
    '        idleTtlSeconds: 300,',
    '        initialContext: "Exercise the packed SDK execution-run stream.",',
    '        verbosity: "short",',
    '      });',
    '      try {',
    '        const stream = await machine.runs.startStream({',
    '          sessionId: session.id,',
    '          runId: startedRun.runId,',
    '          message: "Emit one stream event, then let the caller cancel it.",',
    '        });',
    '        const iterator = stream[Symbol.asyncIterator]();',
    '        const first = await iterator.next();',
    '        if (first.done || !first.value || typeof first.value.t !== "string") {',
    '          throw new Error("packed_sdk_run_stream_emitted_no_event");',
    '        }',
    '        if (!iterator.return) throw new Error("packed_sdk_run_stream_is_not_cancellable");',
    '        await iterator.return();',
    '        result = {',
    '          sessionId: session.id,',
    '          transcript: await session.history({ limit: 10 }),',
    '          runStream: {',
    '            runId: stream.runId,',
    '            streamId: stream.streamId,',
    '            firstEventType: first.value.t,',
    '            cancelled: true,',
    '          },',
    '        };',
    '      } finally {',
    '        await machine.actions.execute("execution.run.stop", {',
    '          sessionId: session.id,',
    '          runId: startedRun.runId,',
    '        });',
    '      }',
    '    } finally {',
    '      await session.stop();',
    '    }',
    '  } else {',
    '    throw new Error("unknown_sdk_driver_operation");',
    '  }',
    '  console.log(JSON.stringify({ ok: true, result }));',
    '} catch (error) {',
    '  const candidate = error && typeof error === "object" ? error : {};',
    '  console.log(JSON.stringify({',
    '    ok: false,',
    '    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),',
    '    ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),',
    '  }));',
    '} finally {',
    '  account.close();',
    '}',
    '',
  ].join('\n'), 'utf8');
  return driverPath;
}

async function installPackedSdkConsumer(params: Readonly<{
  testDir: string;
  sdkCandidateTarballPath: string | null;
}>): Promise<PackedSdkConsumer> {
  const packageDir = resolve(join(params.testDir, 'packed-sdk'));
  const consumerDir = resolve(join(params.testDir, 'sdk-consumer'));
  await Promise.all([
    mkdir(packageDir, { recursive: true }),
    mkdir(consumerDir, { recursive: true }),
  ]);

  const tarballPath = params.sdkCandidateTarballPath ?? await (async () => {
    // The regular source test packs its own sandbox artifact. Candidate validation
    // instead consumes the exact tarball supplied by the release-validation owner.
    const packed = await exportPackSandboxTarball({
      monorepoRoot: repoRootDir(),
      packageRelDir: 'packages/sdk',
      destinationDir: packageDir,
    });
    expect(packed.package).toMatchObject({ name: '@happier-dev/sdk' });
    const tarballName = requireNonEmptyString(packed.tarball?.name, 'SDK tarball name');
    expect(tarballName).toMatch(/\.tgz$/u);
    return resolve(join(packageDir, tarballName));
  })();

  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'external-packed-sdk-consumer',
    private: true,
    type: 'module',
  }, null, 2) + '\n', 'utf8');
  const npmInstallStdoutPath = join(consumerDir, 'npm-install.stdout.log');
  const npmInstallStderrPath = join(consumerDir, 'npm-install.stderr.log');
  await runLoggedCommand({
    command: 'npm',
    args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    cwd: consumerDir,
    env: process.env,
    stdoutPath: npmInstallStdoutPath,
    stderrPath: npmInstallStderrPath,
    timeoutMs: 120_000,
  });

  const driverPath = await writePackedSdkDriver({ consumerDir });
  return {
    consumerDir,
    driverPath,
    logPaths: [npmInstallStdoutPath, npmInstallStderrPath],
    sdkCandidateTarballPath: params.sdkCandidateTarballPath,
  };
}

async function runPackedSdkBasicExample(params: Readonly<{
  consumer: PackedSdkConsumer;
  endpoint: string;
  endpointMode: 'daemon' | 'server';
  token: string;
  workspaceDir: string;
  logPrefix: string;
}>): Promise<Readonly<{
  sessionId: string;
  followedTranscript: readonly unknown[];
  transcript: readonly unknown[];
}>> {
  const examplePath = resolve(
    params.consumer.consumerDir,
    'node_modules',
    '@happier-dev',
    'sdk',
    'examples',
    'basic',
    'index.ts',
  );
  const stdoutPath = join(params.consumer.consumerDir, `${params.logPrefix}.stdout.log`);
  const stderrPath = join(params.consumer.consumerDir, `${params.logPrefix}.stderr.log`);
  params.consumer.logPaths.push(stdoutPath, stderrPath);
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  await runLoggedCommand({
    command: process.execPath,
    args: ['--import', tsxLoader, examplePath],
    cwd: params.consumer.consumerDir,
    env: {
      ...externalConsumerEnv({
        endpoint: params.endpoint,
        token: params.token,
        workspaceDir: params.workspaceDir,
      }),
      HAPPIER_ENDPOINT_MODE: params.endpointMode,
      HAPPIER_AGENT_ID: 'claude',
    },
    stdoutPath,
    stderrPath,
    timeoutMs: PACKED_SDK_SESSION_FLOW_DRIVER_TIMEOUT_MS,
  });
  const result = parseSingleJsonRecord(await readFile(stdoutPath, 'utf8'), 'Packed SDK basic example');
  if (!Array.isArray(result.followedTranscript) || !Array.isArray(result.transcript)) {
    throw new Error('Packed SDK basic example did not return transcript arrays');
  }
  return {
    sessionId: requireNonEmptyString(result.sessionId, 'packed SDK basic-example session id'),
    followedTranscript: result.followedTranscript,
    transcript: result.transcript,
  };
}

function createFakeClaudeSessionTurnSentinel(origin: 'server' | 'local' | 'cli'): FakeClaudeSessionTurnSentinel {
  const fakeClaudeSessionId = `external-sdk-${origin}-${randomUUID()}`;
  return {
    fakeClaudeInvocationId: `fake-claude-invocation-${fakeClaudeSessionId}`,
    fakeClaudeSessionId,
    initialMessage: `Say hello, then wait. [${fakeClaudeSessionId}:turn:1]`,
    followUpMessage: `Please confirm that you are finished. [${fakeClaudeSessionId}:turn:2]`,
  };
}

async function assertFakeClaudeSessionTurnSentinel(params: Readonly<{
  logPath: string;
  sentinel: FakeClaudeSessionTurnSentinel;
}>): Promise<void> {
  const events = parseJsonRecords(await readFile(params.logPath, 'utf8').catch(() => ''));
  expect(events).toContainEqual(expect.objectContaining({
    type: 'invocation',
    mode: 'sdk',
    invocationId: params.sentinel.fakeClaudeInvocationId,
  }));
  const userTextPreviews = events
    .filter((event) => event.type === 'sdk_stdin' && event.invocationId === params.sentinel.fakeClaudeInvocationId)
    .flatMap((event) => typeof event.userTextPreview === 'string' ? [event.userTextPreview] : []);
  expect(userTextPreviews).toEqual(expect.arrayContaining([
    params.sentinel.initialMessage,
    params.sentinel.followUpMessage,
  ]));
}

async function runPackedSdkSessionFlow(params: Readonly<{
  consumer: PackedSdkConsumer;
  endpoint: string;
  token: string;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeClaudeSentinel: FakeClaudeSessionTurnSentinel;
  workspaceDir: string;
  logPrefix: string;
  machineId?: string;
}>): Promise<Readonly<{
  sessionId: string;
  transcript: unknown;
  runStream: PackedSdkRunStreamProbe;
}>> {
  const response = await runExternalSdkDriver({
    consumer: params.consumer,
    endpoint: params.endpoint,
    token: params.token,
    request: {
      endpoint: params.endpoint,
      operation: 'sessionFlow',
      workspaceDir: params.workspaceDir,
      ...(params.machineId ? { machineId: params.machineId } : {}),
      fakeClaudePath: params.fakeClaudePath,
      fakeClaudeLogPath: params.fakeClaudeLogPath,
      fakeClaudeInvocationId: params.fakeClaudeSentinel.fakeClaudeInvocationId,
      fakeClaudeSessionId: params.fakeClaudeSentinel.fakeClaudeSessionId,
      initialMessage: params.fakeClaudeSentinel.initialMessage,
      followUpMessage: params.fakeClaudeSentinel.followUpMessage,
    },
    logPrefix: params.logPrefix,
    timeoutMs: PACKED_SDK_SESSION_FLOW_DRIVER_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`Packed SDK session flow failed (${response.code ?? 'unknown'})`);
  }
  const result = asRecord(response.result);
  const runStream = asRecord(result?.runStream);
  if (!result || !Object.hasOwn(result, 'transcript') || !runStream || runStream.cancelled !== true) {
    throw new Error('Packed SDK session flow did not return transcript and cancelled stream evidence');
  }
  return {
    sessionId: requireNonEmptyString(result.sessionId, 'session-flow session id'),
    transcript: result.transcript,
    runStream: {
      runId: requireNonEmptyString(runStream.runId, 'session-flow stream run id'),
      streamId: requireNonEmptyString(runStream.streamId, 'session-flow stream id'),
      firstEventType: requireNonEmptyString(runStream.firstEventType, 'session-flow stream first event type'),
      cancelled: true,
    },
  };
}

async function runFirstClassCliSessionFlow(params: Readonly<{
  cliLaunchSpec: CliTestLaunchSpec;
  env: NodeJS.ProcessEnv;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeClaudeSentinel: FakeClaudeSessionTurnSentinel;
  logDir: string;
  machineId: string;
  serverUrl: string;
  token: string;
  workspaceDir: string;
}>): Promise<FirstClassCliSessionFlowResult> {
  const logPaths: string[] = [];
  const cliEnv: NodeJS.ProcessEnv = {
    ...params.env,
    ...params.cliLaunchSpec.env,
    HAPPIER_TOKEN: params.token,
  };
  const invokeRaw = async (
    logPrefix: string,
    args: string[],
    timeoutMs = 120_000,
    options: Readonly<{ explicitApiToken?: string }> = {},
  ) => {
    const stdoutPath = join(params.logDir, `${logPrefix}.stdout.log`);
    const stderrPath = join(params.logDir, `${logPrefix}.stderr.log`);
    logPaths.push(stdoutPath, stderrPath);
    const invocationEnv = { ...cliEnv };
    if (options.explicitApiToken) delete invocationEnv.HAPPIER_TOKEN;
    await runLoggedCommand({
      command: params.cliLaunchSpec.command,
      args: [
        ...params.cliLaunchSpec.args,
        '--server-url',
        params.serverUrl,
        ...(options.explicitApiToken ? ['--api-token', options.explicitApiToken] : []),
        ...args,
      ],
      cwd: params.cliLaunchSpec.cwd ?? params.logDir,
      env: invocationEnv,
      stdoutPath,
      stderrPath,
      timeoutMs,
    });
    return await readFile(stdoutPath, 'utf8');
  };
  const invoke = async (
    logPrefix: string,
    args: string[],
    timeoutMs = 120_000,
    options: Readonly<{ explicitApiToken?: string }> = {},
  ) => {
    return parseSingleJsonRecord(
      await invokeRaw(logPrefix, args, timeoutMs, options),
      `First-class CLI ${logPrefix}`,
    );
  };

  const historyHelp = await invokeRaw('cli-first-class-history-help', ['history', '--help']);
  expect(historyHelp).toContain('happier history <session-id-or-prefix-or-tag>');
  expect(historyHelp).not.toContain('happier session');

  const spawned = await invoke('cli-first-class-spawn', [
    'spawn',
    '--path',
    params.workspaceDir,
    '--agent',
    'claude',
    '--machine-id',
    params.machineId,
    '--env',
    `HAPPIER_CLAUDE_PATH=${params.fakeClaudePath}`,
    '--env',
    `HAPPIER_E2E_FAKE_CLAUDE_LOG=${params.fakeClaudeLogPath}`,
    '--env',
    `HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID=${params.fakeClaudeSentinel.fakeClaudeInvocationId}`,
    '--env',
    `HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID=${params.fakeClaudeSentinel.fakeClaudeSessionId}`,
    params.fakeClaudeSentinel.initialMessage,
    '--json',
  ]);
  expect(spawned).toMatchObject({
    v: 1,
    ok: true,
    kind: 'session_create',
    data: { created: true },
  });
  const spawnedData = asRecord(spawned.data);
  const spawnedSession = asRecord(spawnedData?.session);
  const sessionId = requireNonEmptyString(spawnedSession?.id, 'first-class CLI spawned session id');
  const uniqueSessionPrefix = sessionId.slice(0, 12);
  if (uniqueSessionPrefix.length !== 12) {
    throw new Error('First-class CLI spawned session id is too short for a unique-prefix probe');
  }

  let followProcess: SpawnedProcess | null = null;
  try {
    const initialIdle = await invoke('cli-first-class-wait-initial', [
      'wait',
      sessionId,
      '--timeout',
      String(PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS),
      '--json',
    ], PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS * 1_000 + 30_000);
    expect(initialIdle).toMatchObject({
      v: 1,
      ok: true,
      kind: 'session_wait',
      data: { sessionId, idle: true },
    });

    const followStdoutPath = join(params.logDir, 'cli-first-class-history-follow.stdout.log');
    const followStderrPath = join(params.logDir, 'cli-first-class-history-follow.stderr.log');
    logPaths.push(followStdoutPath, followStderrPath);
    followProcess = spawnLoggedProcess({
      command: params.cliLaunchSpec.command,
      args: [
        ...params.cliLaunchSpec.args,
        '--server-url',
        params.serverUrl,
        'history',
        uniqueSessionPrefix,
        '--follow',
        '--jsonl',
      ],
      cwd: params.cliLaunchSpec.cwd ?? params.logDir,
      env: cliEnv,
      stdoutPath: followStdoutPath,
      stderrPath: followStderrPath,
    });
    // The finite follow action starts from tail. Give the first CLI poll time
    // to acquire that cursor before the distinct follow-up turn is admitted.
    await sleep(1_000);

    const sent = await invoke('cli-first-class-send', [
      'send',
      uniqueSessionPrefix,
      params.fakeClaudeSentinel.followUpMessage,
      '--json',
    ]);
    expect(sent).toMatchObject({
      v: 1,
      ok: true,
      kind: 'session_send',
      data: { sessionId },
    });

    const followUpIdle = await invoke('cli-first-class-wait-follow-up', [
      'wait',
      uniqueSessionPrefix,
      '--timeout',
      String(PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS),
      '--json',
    ], PACKED_SDK_SESSION_IDLE_TIMEOUT_SECONDS * 1_000 + 30_000);
    expect(followUpIdle).toMatchObject({
      v: 1,
      ok: true,
      kind: 'session_wait',
      data: { sessionId, idle: true },
    });

    const firstClassHistoryRaw = await invokeRaw('cli-first-class-history', [
      'history',
      uniqueSessionPrefix,
      '--tail',
      '10',
      '--json',
    ]);
    const history = parseSingleJsonRecord(firstClassHistoryRaw, 'First-class CLI cli-first-class-history');
    expect(history).toMatchObject({
      v: 1,
      ok: true,
      kind: 'session_history',
      data: { sessionId, messages: expect.any(Array) },
    });
    const historyData = asRecord(history.data);
    if (!historyData || !Array.isArray(historyData.messages)) {
      throw new Error('First-class CLI history did not return messages');
    }

    const nestedHistoryRaw = await invokeRaw('cli-nested-history', [
      'session',
      'history',
      uniqueSessionPrefix,
      '--tail',
      '10',
      '--json',
    ]);
    expect(nestedHistoryRaw).toBe(firstClassHistoryRaw);

    const compactHistory = await invokeRaw('cli-first-class-history-compact', [
      'history',
      uniqueSessionPrefix,
      '--tail',
      '10',
    ]);
    expect(compactHistory).toContain(`assistant: FAKE_CLAUDE_OK_2`);
    expect(compactHistory).toContain('History fetched (');

    const delegated = await invoke('cli-first-class-delegate', [
      'delegate',
      uniqueSessionPrefix,
      'Confirm the current Agent can run a delegated task.',
      '--agent',
      'claude',
      '--permission-mode',
      'read_only',
      '--json',
    ], 120_000, { explicitApiToken: params.token });
    expect(delegated).toMatchObject({
      v: 1,
      ok: true,
      kind: 'session_delegate_start',
      data: {
        sessionId,
        results: expect.arrayContaining([
          expect.objectContaining({ key: expect.stringContaining('claude'), ok: true }),
        ]),
      },
    });

    return { sessionId, transcript: historyData.messages, logPaths };
  } finally {
    try {
      const stopped = await invoke('cli-first-class-stop', ['stop', uniqueSessionPrefix, '--json']);
      expect(stopped).toMatchObject({
        v: 1,
        ok: true,
        kind: 'session_stop',
        data: { sessionId },
      });
    } finally {
      if (followProcess) {
        try {
          await waitForLoggedProcessExit(followProcess, 'first-class history --follow termination');
        } catch (error) {
          await followProcess.stop().catch(() => {});
          throw error;
        }
        const followOutput = await readFile(followProcess.stdoutPath, 'utf8');
        const followLines = followOutput.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
        const followRecords = parseJsonRecords(followOutput);
        expect(followRecords).toHaveLength(followLines.length);
        expect(followRecords).not.toHaveLength(0);
        expect(JSON.stringify(followRecords)).toContain(params.fakeClaudeSentinel.followUpMessage);
      }
    }
  }
}

async function requestRawExternalAction(params: Readonly<{
  actionId: string;
  baseUrl: string;
  body: Readonly<Record<string, unknown>>;
  token: string;
}>) {
  return await fetchJson<unknown>(
    `${params.baseUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(params.actionId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params.body),
      timeoutMs: 20_000,
    },
  );
}

function externalDriverEnv(params: Readonly<{
  endpoint: string;
  token: string;
  request: ExternalSdkDriverRequest;
}>): NodeJS.ProcessEnv {
  return {
    ...externalConsumerEnv({
      endpoint: params.endpoint,
      token: params.token,
      machineId: params.request.machineId,
    }),
    HAPPIER_E2E_SDK_DRIVER_REQUEST: JSON.stringify(params.request),
  };
}

async function runExternalSdkDriver(params: Readonly<{
  consumer: PackedSdkConsumer;
  endpoint: string;
  token: string;
  request: ExternalSdkDriverRequest;
  logPrefix: string;
  timeoutMs?: number;
}>): Promise<ExternalSdkDriverResult> {
  const stdoutPath = join(params.consumer.consumerDir, `${params.logPrefix}.stdout.log`);
  const stderrPath = join(params.consumer.consumerDir, `${params.logPrefix}.stderr.log`);
  params.consumer.logPaths.push(stdoutPath, stderrPath);
  await runLoggedCommand({
    command: process.execPath,
    args: [params.consumer.driverPath],
    cwd: params.consumer.consumerDir,
    env: externalDriverEnv(params),
    stdoutPath,
    stderrPath,
    timeoutMs: params.timeoutMs ?? 60_000,
  });
  return parseExternalSdkDriverResult(await readFile(stdoutPath, 'utf8'));
}

function startExternalSdkDriver(params: Readonly<{
  consumer: PackedSdkConsumer;
  endpoint: string;
  token: string;
  request: ExternalSdkDriverRequest;
  logPrefix: string;
}>): SpawnedProcess {
  const stdoutPath = join(params.consumer.consumerDir, `${params.logPrefix}.stdout.log`);
  const stderrPath = join(params.consumer.consumerDir, `${params.logPrefix}.stderr.log`);
  params.consumer.logPaths.push(stdoutPath, stderrPath);
  return spawnLoggedProcess({
    command: process.execPath,
    args: [params.consumer.driverPath],
    cwd: params.consumer.consumerDir,
    env: externalDriverEnv(params),
    stdoutPath,
    stderrPath,
  });
}

async function waitForExternalSdkDriverResult(process: SpawnedProcess): Promise<ExternalSdkDriverResult> {
  if (process.child.exitCode === null && process.child.signalCode === null) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.child.once('error', rejectPromise);
      process.child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(`Packed SDK driver exited unsuccessfully (${signal ?? code ?? 'unknown'})`));
      });
    });
  }
  if (process.child.exitCode !== 0 || process.child.signalCode !== null) {
    throw new Error('Packed SDK driver exited unsuccessfully');
  }
  return parseExternalSdkDriverResult(await readFile(process.stdoutPath, 'utf8'));
}

async function waitForLoggedProcessExit(process: SpawnedProcess, context: string): Promise<void> {
  await waitFor(async () => process.child.exitCode !== null || process.child.signalCode !== null, {
    timeoutMs: 45_000,
    intervalMs: 100,
    context,
  });
  expect(process.child.exitCode).toBe(0);
  expect(process.child.signalCode).toBeNull();
}

function buildTargetActionArtifactHeader(request: TargetActionApprovalRequestV1): Readonly<Record<string, unknown>> {
  return {
    v: 1,
    kind: 'target_action_approval.v1',
    title: request.summary,
    approvalStatus: request.status,
    qualifiedActionId: request.qualifiedActionId,
    subjectFingerprint: request.subjectFingerprint,
  };
}

function decodeTargetActionArtifact(params: Readonly<{
  artifact: ArtifactRecord;
  cliAccessKey: CliAccessKey;
}>): OpenTargetActionApproval | null {
  const header = decodeEncryptedArtifactJsonBase64ForCliAccessKey<Record<string, unknown>>({
    encryptedJsonBase64: params.artifact.header,
    dataEncryptionKeyBase64: params.artifact.dataEncryptionKey,
    cliAccessKey: params.cliAccessKey,
  });
  if (
    header?.kind !== 'target_action_approval.v1'
    || typeof header.qualifiedActionId !== 'string'
    || typeof header.subjectFingerprint !== 'string'
  ) {
    return null;
  }
  const body = decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body?: unknown }>({
    encryptedJsonBase64: params.artifact.body,
    dataEncryptionKeyBase64: params.artifact.dataEncryptionKey,
    cliAccessKey: params.cliAccessKey,
  });
  if (typeof body?.body !== 'string') return null;
  const parsed = (() => {
    try {
      return TargetActionApprovalRequestV1Schema.safeParse(JSON.parse(body.body));
    } catch {
      return { success: false as const };
    }
  })();
  if (!parsed.success) return null;
  if (
    parsed.data.qualifiedActionId !== header.qualifiedActionId
    || parsed.data.subjectFingerprint !== header.subjectFingerprint
  ) {
    return null;
  }
  return { artifact: params.artifact, request: parsed.data };
}

async function waitForOpenTargetActionApproval(params: Readonly<{
  baseUrl: string;
  token: string;
  cliAccessKey: CliAccessKey;
  inputMarker: string;
}>): Promise<OpenTargetActionApproval> {
  let found: OpenTargetActionApproval | null = null;
  await waitFor(async () => {
    const artifacts = await listArtifactsViaApi({ baseUrl: params.baseUrl, token: params.token });
    for (const item of artifacts) {
      const artifact = await fetchArtifactViaApi({
        baseUrl: params.baseUrl,
        token: params.token,
        artifactId: item.id,
      });
      const opened = decodeTargetActionArtifact({ artifact, cliAccessKey: params.cliAccessKey });
      if (
        opened?.request.status === 'open'
        && opened.request.qualifiedActionId === EXTERNAL_ACTION_ID
        && asRecord(opened.request.input)?.marker === params.inputMarker
      ) {
        found = opened;
        return true;
      }
    }
    return false;
  }, {
    timeoutMs: 45_000,
    intervalMs: 100,
    context: `open API target-action approval for ${params.inputMarker}`,
  });
  if (!found) throw new Error('Expected open target-action approval artifact');
  return found;
}

async function decideTargetActionApproval(params: Readonly<{
  baseUrl: string;
  token: string;
  cliAccessKey: CliAccessKey;
  approval: OpenTargetActionApproval;
  decision: 'approve' | 'reject';
}>): Promise<TargetActionApprovalRequestV1> {
  const decidedAtMs = Math.max(Date.now(), params.approval.request.updatedAtMs + 1);
  const request = TargetActionApprovalRequestV1Schema.parse({
    ...params.approval.request,
    status: params.decision === 'approve' ? 'approved' : 'rejected',
    updatedAtMs: decidedAtMs,
    decision: { kind: params.decision, decidedAtMs },
  });
  const updated = await updateEncryptedArtifactViaApi({
    baseUrl: params.baseUrl,
    token: params.token,
    artifact: params.approval.artifact,
    cliAccessKey: params.cliAccessKey,
    headerJson: buildTargetActionArtifactHeader(request),
    bodyJson: { body: JSON.stringify(request) },
  });
  expect(updated).toMatchObject({ success: true });
  return request;
}

async function waitForTargetActionApprovalExecution(params: Readonly<{
  baseUrl: string;
  token: string;
  cliAccessKey: CliAccessKey;
  artifactId: string;
}>): Promise<TargetActionApprovalRequestV1> {
  let request: TargetActionApprovalRequestV1 | null = null;
  await waitFor(async () => {
    const artifact = await fetchArtifactViaApi({
      baseUrl: params.baseUrl,
      token: params.token,
      artifactId: params.artifactId,
    });
    const opened = decodeTargetActionArtifact({ artifact, cliAccessKey: params.cliAccessKey });
    if (opened?.request.status === 'executed' && opened.request.execution?.ok === true) {
      request = opened.request;
      return true;
    }
    return false;
  }, {
    timeoutMs: 45_000,
    intervalMs: 100,
    context: 'executed target-action approval',
  });
  if (!request) throw new Error('Expected executed target-action approval');
  return request;
}

async function readMarkerLines(markerPath: string): Promise<string[]> {
  return (await readFile(markerPath, 'utf8').catch(() => ''))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitForMarkerLineCount(markerPath: string, expected: number): Promise<void> {
  await waitFor(async () => {
    expect(await readMarkerLines(markerPath)).toHaveLength(expected);
    return true;
  }, {
    timeoutMs: 45_000,
    intervalMs: 100,
    context: `plugin action marker count ${expected}`,
  });
}

async function requestApiTokenCreate(params: Readonly<{
  baseUrl: string;
  token: string;
  label: string;
}>) {
  return await fetchJson<unknown>(`${params.baseUrl}${ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label: params.label }),
    timeoutMs: 20_000,
  });
}

async function createApiToken(params: Readonly<{
  baseUrl: string;
  presentUserToken: string;
  label: string;
}>): Promise<Readonly<{ token: string; tokenId: string }>> {
  const response = await requestApiTokenCreate({
    baseUrl: params.baseUrl,
    token: params.presentUserToken,
    label: params.label,
  });
  const body = asRecord(response.data);
  const apiToken = asRecord(body?.apiToken);
  if (response.status !== 200 || !body || !apiToken) {
    throw new Error(`Present-user API token create failed (status=${response.status})`);
  }
  return {
    token: requireNonEmptyString(body.token, 'created API token'),
    tokenId: requireNonEmptyString(apiToken.tokenId, 'created API token id'),
  };
}

async function revokeApiToken(params: Readonly<{
  baseUrl: string;
  presentUserToken: string;
  tokenId: string;
}>): Promise<void> {
  const response = await fetchJson<unknown>(`${params.baseUrl}${ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.presentUserToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tokenId: params.tokenId }),
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  expect(asRecord(response.data)).toMatchObject({ revoked: true });
}

async function waitForMachineRegistration(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId: string;
}>): Promise<void> {
  await waitFor(async () => {
    const response = await fetchJson<unknown>(`${params.baseUrl}/v1/machines`, {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 10_000,
    });
    if (response.status !== 200 || !Array.isArray(response.data)) return false;
    return response.data.some((value) => asRecord(value)?.id === params.machineId);
  }, {
    timeoutMs: 60_000,
    intervalMs: 200,
    context: 'daemon machine registration',
  });
}

async function installReviewedPackedPlugin(params: Readonly<{
  testDir: string;
  daemon: StartedDaemon;
  daemonHomeDir: string;
  serverBaseUrl: string;
  markerPath: string;
}>): Promise<void> {
  const pluginRoot = resolve(join(params.testDir, 'external-action-plugin'));
  const archivePath = resolve(join(params.testDir, 'external-action-plugin.happier-plugin.tgz'));
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: '@acme/external-action-live-fixture',
    version: '1.0.0',
    type: 'module',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }, null, 2) + '\n', 'utf8');
  await writeLocalExtensionPackageFixture({
    pluginRoot,
    manifest: createLocalExtensionPackageManifest({
      pluginId: EXTERNAL_PLUGIN_ID,
      displayName: 'External Action Live Fixture',
      description: 'Packed external Action fixture for the dual-origin SDK gate',
      contributes: {
        actions: [createPluginActionContribution({
          actionId: EXTERNAL_ACTION_LOCAL_ID,
          title: 'Inspect',
          description: 'Writes an exact-once marker when a reviewed Action is executed',
        })],
      },
    }),
    daemonModuleContents: [
      'import { appendFile } from "node:fs/promises";',
      '',
      'export async function activate(api) {',
      '  api.registerAction({',
      `    id: ${JSON.stringify(EXTERNAL_ACTION_LOCAL_ID)},`,
      '    handler: async (request = {}) => {',
      `      await appendFile(${JSON.stringify(params.markerPath)}, "invoked\\n", "utf8");`,
      '      return { ok: true, data: { input: request.input ?? null } };',
      '    },',
      '  });',
      '}',
      '',
    ].join('\n'),
  });
  const packed = await packLocalPlugin({ locator: pluginRoot, outPath: archivePath });
  expect(packed.ok, packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n')).toBe(true);
  if (!packed.ok) throw new Error('Packed plugin fixture was rejected');

  const requested = await daemonControlPostJson<Record<string, unknown>>({
    port: params.daemon.state.httpPort,
    controlToken: params.daemon.state.controlToken,
    path: PLUGIN_CHANGE_REQUEST_PATH,
    body: {
      kind: 'installArchive',
      locator: packed.archivePath,
      expectedIntegrity: packed.archiveIntegrity,
    },
  });
  expect(requested.status).toBe(200);
  expect(requested.data).toMatchObject({
    kind: 'reviewRequired',
    review: {
      pluginId: EXTERNAL_PLUGIN_ID,
      source: {
        kind: 'archive',
        locator: packed.archivePath,
        integrity: packed.archiveIntegrity,
      },
    },
  });
  const pendingChangeId = requireNonEmptyString(requested.data.pendingChangeId, 'plugin review pending change id');
  const decision = await decideAuthenticatedPluginInstallReview({
    cliHomeDir: params.daemonHomeDir,
    serverUrl: params.serverBaseUrl,
    pendingChangeId,
    optionalSelections: [],
    confirmPresentUser: async () => true,
  });
  expect(decision).toMatchObject({
    kind: 'committed',
    pluginId: EXTERNAL_PLUGIN_ID,
    desiredGeneration: expect.any(String),
    appliedGeneration: expect.any(String),
  });
}

async function assertTokensAbsentFromLogs(params: Readonly<{
  tokens: readonly string[];
  paths: readonly string[];
}>): Promise<void> {
  for (const path of params.paths) {
    const content = await readFile(path, 'utf8').catch(() => '');
    for (const token of params.tokens) {
      if (content.includes(token)) {
        throw new Error('API token leaked into a daemon or server process log');
      }
    }
  }
}

describe('core e2e: packed SDK external Actions use one authenticated daemon executor through local and relay origins', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let pendingDriver: SpawnedProcess | null = null;
  let pendingDaemonLaunchSpec: CliTestLaunchSpec | null = null;

  afterEach(async () => {
    await pendingDriver?.stop().catch(() => {});
    pendingDriver = null;
    await daemon?.stop().catch(() => {});
    daemon = null;
    await Promise.resolve()
      .then(() => pendingDaemonLaunchSpec?.cleanup?.())
      .catch(() => {});
    pendingDaemonLaunchSpec = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('runs the packed external SDK over the server relay and local daemon, with reviewed plugin approval and bounded PAT validation', async () => {
    const testDir = run.testDir(`external-actions-dual-origin-${randomUUID()}`);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const daemonRuntimeDir = resolve(join(testDir, 'daemon-runtime'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const actionMarkerPath = resolve(join(testDir, 'external-action-invocations.log'));
    await Promise.all([
      mkdir(daemonHomeDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);

    const liveEnv = buildPreAttestedExternalSessionLiveEnv();
    pendingDaemonLaunchSpec = await resolveCliTestLaunchSpec(
      {
        testDir: daemonRuntimeDir,
        env: {
          ...process.env,
          ...liveEnv,
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '0',
          HAPPY_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '0',
          CI: '1',
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_HOME_DIR: daemonHomeDir,
        },
      },
      {
        snapshotDir: resolve(join(daemonRuntimeDir, 'cli-source-snapshot')),
        skipDistIntegrityCheck: true,
      },
    );
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: liveEnv,
    });
    const auth = await createTestAuth(server.baseUrl);
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      material: { type: 'dataKey', machineKey: auth.accountMachineKey },
      settings: {
        schemaVersion: 2,
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.status.get': {
              enabled: true,
              disabledSurfaces: ['api'],
              disabledPlacements: [],
              approvalRequiredSurfaces: [],
            },
            [EXTERNAL_ACTION_ID]: {
              enabled: true,
              disabledSurfaces: [],
              disabledPlacements: [],
              approvalRequiredSurfaces: ['api'],
            },
          },
        },
      },
    });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const sdkCandidateTarballPath = resolveReleaseValidationSdkTarball();
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...liveEnv,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
    };
    delete daemonEnv.HAPPIER_CLAUDE_PATH;
    delete daemonEnv.HAPPIER_E2E_FAKE_CLAUDE_LOG;
    delete daemonEnv.HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID;
    delete daemonEnv.HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID;
    delete daemonEnv.HAPPY_CLAUDE_PATH;
    delete daemonEnv.HAPPY_E2E_FAKE_CLAUDE_LOG;
    delete daemonEnv.HAPPY_E2E_FAKE_CLAUDE_INVOCATION_ID;
    delete daemonEnv.HAPPY_E2E_FAKE_CLAUDE_SESSION_ID;
    if (sdkCandidateTarballPath) {
      // The shipped example does not carry test-only spawn environment controls.
      // Configure the daemon's test fixture once so both public origins can run it.
      daemonEnv.HAPPIER_CLAUDE_PATH = fakeClaudePath;
      daemonEnv.HAPPIER_E2E_FAKE_CLAUDE_LOG = fakeClaudeLogPath;
    }
    const daemonLaunchSpec = pendingDaemonLaunchSpec;
    if (!daemonLaunchSpec) throw new Error('Expected a prepared daemon CLI launch spec');
    // startTestDaemon owns launch-spec cleanup from invocation onward, including startup failure.
    pendingDaemonLaunchSpec = null;
    daemon = await startTestDaemon({
      testDir: daemonRuntimeDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      cliLaunchSpec: daemonLaunchSpec,
    });
    await waitForMachineRegistration({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: seeded.machineId,
    });
    const cliAccessKey = await readCliAccessKey(daemonHomeDir);
    if (!cliAccessKey || !('encryption' in cliAccessKey)) {
      throw new Error('Expected seeded data-key CLI access key');
    }

    const primaryPat = await createApiToken({
      baseUrl: server.baseUrl,
      presentUserToken: auth.token,
      label: 'dual-origin packed SDK primary',
    });
    const consumer = await installPackedSdkConsumer({ testDir, sdkCandidateTarballPath });

    // No daemon address or machine id is supplied here. The packed test-owned
    // consumer must discover the current machine through the Account server then relay.
    const serverFakeClaudeSentinel = createFakeClaudeSessionTurnSentinel('server');
    const serverSession = await runPackedSdkSessionFlow({
      consumer,
      endpoint: server.baseUrl,
      token: primaryPat.token,
      workspaceDir,
      fakeClaudePath,
      fakeClaudeLogPath,
      fakeClaudeSentinel: serverFakeClaudeSentinel,
      logPrefix: 'server-basic',
    });
    await assertFakeClaudeSessionTurnSentinel({
      logPath: fakeClaudeLogPath,
      sentinel: serverFakeClaudeSentinel,
    });
    expect(JSON.stringify(serverSession.transcript)).toContain('FAKE_CLAUDE_OK_2');
    expect(serverSession.runStream).toMatchObject({
      cancelled: true,
      runId: expect.any(String),
      streamId: expect.any(String),
      firstEventType: expect.any(String),
    });

    const localEndpoint = `http://127.0.0.1:${daemon.state.httpPort}`;
    const localFakeClaudeSentinel = createFakeClaudeSessionTurnSentinel('local');
    const localSession = await runPackedSdkSessionFlow({
      consumer,
      endpoint: localEndpoint,
      token: primaryPat.token,
      workspaceDir,
      machineId: seeded.machineId,
      fakeClaudePath,
      fakeClaudeLogPath,
      fakeClaudeSentinel: localFakeClaudeSentinel,
      logPrefix: 'local-basic',
    });
    await assertFakeClaudeSessionTurnSentinel({
      logPath: fakeClaudeLogPath,
      sentinel: localFakeClaudeSentinel,
    });
    expect(localSession.sessionId).not.toBe(serverSession.sessionId);
    expect(JSON.stringify(localSession.transcript)).toContain('FAKE_CLAUDE_OK_2');
    expect(localSession.runStream).toMatchObject({
      cancelled: true,
      runId: expect.any(String),
      streamId: expect.any(String),
      firstEventType: expect.any(String),
    });

    if (consumer.sdkCandidateTarballPath) {
      const serverBasicExample = await runPackedSdkBasicExample({
        consumer,
        endpoint: server.baseUrl,
        endpointMode: 'server',
        token: primaryPat.token,
        workspaceDir,
        logPrefix: 'server-shipped-basic-example',
      });
      const localBasicExample = await runPackedSdkBasicExample({
        consumer,
        endpoint: localEndpoint,
        endpointMode: 'daemon',
        token: primaryPat.token,
        workspaceDir,
        logPrefix: 'local-shipped-basic-example',
      });
      expect(serverBasicExample.sessionId).not.toBe(localBasicExample.sessionId);
      expect(serverBasicExample.followedTranscript).not.toHaveLength(0);
      expect(serverBasicExample.transcript).not.toHaveLength(0);
      expect(localBasicExample.followedTranscript).not.toHaveLength(0);
      expect(localBasicExample.transcript).not.toHaveLength(0);
    }

    const cliFakeClaudeSentinel = createFakeClaudeSessionTurnSentinel('cli');
    const cliSession = await runFirstClassCliSessionFlow({
      cliLaunchSpec: daemonLaunchSpec,
      env: daemonEnv,
      fakeClaudeLogPath,
      fakeClaudePath,
      fakeClaudeSentinel: cliFakeClaudeSentinel,
      logDir: testDir,
      machineId: seeded.machineId,
      serverUrl: server.baseUrl,
      token: primaryPat.token,
      workspaceDir,
    });
    await assertFakeClaudeSessionTurnSentinel({
      logPath: fakeClaudeLogPath,
      sentinel: cliFakeClaudeSentinel,
    });
    expect(JSON.stringify(cliSession.transcript)).toContain('FAKE_CLAUDE_OK_2');

    const rawBackendsRequestId = `raw-backends-${randomUUID()}`;
    const serverRawBackends = await requestRawExternalAction({
      actionId: 'agents.backends.list',
      baseUrl: server.baseUrl,
      token: primaryPat.token,
      body: {
        v: 1,
        requestId: rawBackendsRequestId,
        target: { kind: 'machine', machineId: seeded.machineId },
        input: { includeDisabled: true },
      },
    });
    expect(serverRawBackends.status).toBe(200);
    expect(serverRawBackends.headers.get('cache-control')).toBe('no-store');
    expect(serverRawBackends.data).toMatchObject({
      v: 1,
      actionId: 'agents.backends.list',
      requestId: rawBackendsRequestId,
      execution: {
        ok: true,
        result: { items: expect.any(Array) },
      },
    });
    const serverRawMalformed = await requestRawExternalAction({
      actionId: 'agents.backends.list',
      baseUrl: server.baseUrl,
      token: primaryPat.token,
      body: {
        v: 1,
        target: { kind: 'machine', machineId: seeded.machineId },
        input: { includeDisabled: true },
        authority: 'forged',
      },
    });
    expect(serverRawMalformed.status).toBe(400);
    expect(serverRawMalformed.headers.get('cache-control')).toBe('no-store');
    expect(serverRawMalformed.data).toEqual({ error: 'invalid_request', code: 'invalid_envelope' });

    const daemonRawBackends = await requestRawExternalAction({
      actionId: 'agents.backends.list',
      baseUrl: localEndpoint,
      token: primaryPat.token,
      body: {
        v: 1,
        requestId: rawBackendsRequestId,
        input: { includeDisabled: true },
      },
    });
    expect(daemonRawBackends.status).toBe(200);
    expect(daemonRawBackends.headers.get('cache-control')).toBe('no-store');
    expect(daemonRawBackends.data).toMatchObject({
      v: 1,
      actionId: 'agents.backends.list',
      requestId: rawBackendsRequestId,
      execution: {
        ok: true,
        result: { items: expect.any(Array) },
      },
    });
    expect(daemonRawBackends.data).toEqual(serverRawBackends.data);
    const daemonRawMalformed = await requestRawExternalAction({
      actionId: 'agents.backends.list',
      baseUrl: localEndpoint,
      token: primaryPat.token,
      body: {
        v: 1,
        input: { includeDisabled: true },
        authority: 'forged',
      },
    });
    expect(daemonRawMalformed.status).toBe(400);
    expect(daemonRawMalformed.headers.get('cache-control')).toBe('no-store');
    expect(daemonRawMalformed.data).toEqual({ error: 'invalid_request', code: 'invalid_envelope' });
    expect(daemonRawMalformed.data).toEqual(serverRawMalformed.data);

    await installReviewedPackedPlugin({
      testDir,
      daemon,
      daemonHomeDir,
      serverBaseUrl: server.baseUrl,
      markerPath: actionMarkerPath,
    });

    const localActionSearch = await runExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: primaryPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'search',
        query: EXTERNAL_ACTION_ID,
      },
      logPrefix: 'local-contributed-action-search',
    });
    expect(localActionSearch).toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: EXTERNAL_ACTION_ID }),
        ]),
      },
    });
    const relayActionSearch = await runExternalSdkDriver({
      consumer,
      endpoint: server.baseUrl,
      token: primaryPat.token,
      request: {
        endpoint: server.baseUrl,
        machineId: seeded.machineId,
        operation: 'search',
        query: EXTERNAL_ACTION_ID,
      },
      logPrefix: 'relay-contributed-action-search',
    });
    expect(relayActionSearch).toMatchObject({
      ok: true,
      result: {
        actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: EXTERNAL_ACTION_ID }),
        ]),
      },
    });

    const approvedMarker = `approve-${randomUUID()}`;
    const directApprovalDriver = startExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: primaryPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'invoke',
        input: { marker: approvedMarker },
      },
      logPrefix: 'direct-approved-action',
    });
    pendingDriver = directApprovalDriver;
    const directApproval = await waitForOpenTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      inputMarker: approvedMarker,
    });
    expect(directApproval.request).toMatchObject({
      requestedSurface: 'api',
      qualifiedActionId: EXTERNAL_ACTION_ID,
      status: 'open',
      input: { marker: approvedMarker },
      subjectFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(await readMarkerLines(actionMarkerPath)).toEqual([]);
    expect(directApprovalDriver.child.exitCode).toBeNull();
    expect(directApprovalDriver.child.signalCode).toBeNull();
    await decideTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      approval: directApproval,
      decision: 'approve',
    });
    expect(await waitForExternalSdkDriverResult(directApprovalDriver)).toMatchObject({ ok: true });
    pendingDriver = null;
    await waitForMarkerLineCount(actionMarkerPath, 1);
    const execution = await waitForTargetActionApprovalExecution({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      artifactId: directApproval.artifact.id,
    });
    expect(execution.execution).toMatchObject({ ok: true });

    const relayApprovedMarker = `relay-approve-${randomUUID()}`;
    const relayApprovalDriver = startExternalSdkDriver({
      consumer,
      endpoint: server.baseUrl,
      token: primaryPat.token,
      request: {
        endpoint: server.baseUrl,
        machineId: seeded.machineId,
        operation: 'invoke',
        input: { marker: relayApprovedMarker },
      },
      logPrefix: 'relay-approved-action',
    });
    pendingDriver = relayApprovalDriver;
    const relayApproved = await waitForOpenTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      inputMarker: relayApprovedMarker,
    });
    expect(relayApproved.request).toMatchObject({
      requestedSurface: 'api',
      qualifiedActionId: EXTERNAL_ACTION_ID,
      status: 'open',
      input: { marker: relayApprovedMarker },
    });
    expect(await readMarkerLines(actionMarkerPath)).toHaveLength(1);
    expect(relayApprovalDriver.child.exitCode).toBeNull();
    expect(relayApprovalDriver.child.signalCode).toBeNull();
    await decideTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      approval: relayApproved,
      decision: 'approve',
    });
    expect(await waitForExternalSdkDriverResult(relayApprovalDriver)).toMatchObject({ ok: true });
    pendingDriver = null;
    await waitForMarkerLineCount(actionMarkerPath, 2);
    const relayExecution = await waitForTargetActionApprovalExecution({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      artifactId: relayApproved.artifact.id,
    });
    expect(relayExecution.execution).toMatchObject({ ok: true });

    const rejectedMarker = `reject-${randomUUID()}`;
    const relayRejectionDriver = startExternalSdkDriver({
      consumer,
      endpoint: server.baseUrl,
      token: primaryPat.token,
      request: {
        endpoint: server.baseUrl,
        machineId: seeded.machineId,
        operation: 'invoke',
        input: { marker: rejectedMarker },
      },
      logPrefix: 'relay-rejected-action',
    });
    pendingDriver = relayRejectionDriver;
    const relayApproval = await waitForOpenTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      inputMarker: rejectedMarker,
    });
    expect(await readMarkerLines(actionMarkerPath)).toHaveLength(2);
    expect(relayRejectionDriver.child.exitCode).toBeNull();
    expect(relayRejectionDriver.child.signalCode).toBeNull();
    await decideTargetActionApproval({
      baseUrl: server.baseUrl,
      token: auth.token,
      cliAccessKey,
      approval: relayApproval,
      decision: 'reject',
    });
    expect(await waitForExternalSdkDriverResult(relayRejectionDriver)).toMatchObject({
      ok: false,
      code: 'plugin_action_current_intent_rejected',
    });
    pendingDriver = null;
    expect(await readMarkerLines(actionMarkerPath)).toHaveLength(2);

    const disabled = await runExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: primaryPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'sessionStatus',
        sessionId: localSession.sessionId,
      },
      logPrefix: 'api-disabled',
    });
    expect(disabled).toMatchObject({ ok: false, code: 'action_disabled' });

    const patCannotManagePats = await requestApiTokenCreate({
      baseUrl: server.baseUrl,
      token: primaryPat.token,
      label: 'must-not-mint-from-pat',
    });
    expect(patCannotManagePats).toMatchObject({
      status: 403,
      data: { error: 'present_user_required' },
    });

    const cachedPat = await createApiToken({
      baseUrl: server.baseUrl,
      presentUserToken: auth.token,
      label: 'dual-origin cache-expiry',
    });
    const warmDirect = await runExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: cachedPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'sessionStatus',
        sessionId: serverSession.sessionId,
      },
      logPrefix: 'cache-warm-direct',
    });
    expect(warmDirect).toMatchObject({ ok: false, code: 'action_disabled' });
    await revokeApiToken({
      baseUrl: server.baseUrl,
      presentUserToken: auth.token,
      tokenId: cachedPat.tokenId,
    });
    const revokedAtServer = await runExternalSdkDriver({
      consumer,
      endpoint: server.baseUrl,
      token: cachedPat.token,
      request: {
        endpoint: server.baseUrl,
        machineId: seeded.machineId,
        operation: 'sessionStatus',
        sessionId: serverSession.sessionId,
      },
      logPrefix: 'cache-revoked-server',
    });
    expect(revokedAtServer).toMatchObject({ ok: false, code: 'invalid_token', status: 401 });
    const cachedAtDaemon = await runExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: cachedPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'sessionStatus',
        sessionId: serverSession.sessionId,
      },
      logPrefix: 'cache-still-warm-direct',
    });
    expect(cachedAtDaemon).toMatchObject({ ok: false, code: 'action_disabled' });

    const serverLogPaths = [server.proc.stdoutPath, server.proc.stderrPath];
    await server.stop();
    server = null;
    // This is the released cache contract (60 seconds), not a test-only TTL.
    await sleep(60_250);
    const expiredWithServerDown = await runExternalSdkDriver({
      consumer,
      endpoint: localEndpoint,
      token: cachedPat.token,
      request: {
        endpoint: localEndpoint,
        machineId: seeded.machineId,
        operation: 'sessionStatus',
        sessionId: serverSession.sessionId,
      },
      logPrefix: 'cache-expired-server-down',
    });
    expect(expiredWithServerDown).toMatchObject({ ok: false, code: 'auth_unavailable', status: 503 });
    await assertTokensAbsentFromLogs({
      tokens: [primaryPat.token, cachedPat.token],
      paths: [
        ...serverLogPaths,
        daemon.proc.stdoutPath,
        daemon.proc.stderrPath,
        ...consumer.logPaths,
        ...cliSession.logPaths,
      ],
    });
  }, DUAL_ORIGIN_E2E_TIMEOUT_MS);
});
