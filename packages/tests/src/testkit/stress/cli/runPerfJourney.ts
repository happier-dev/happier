import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { createTestAuth } from '../../auth';
import { buildTestAccountCliAuthCredentials, seedCliAuthForTestAccount } from '../../cliAuth';
import { createEncryptedArtifactViaApi, decodeEncryptedArtifactJsonBase64ForCliAccessKey, fetchArtifactViaApi } from '../../artifactApi';
import { startTestDaemon } from '../../daemon/daemon';
import { daemonControlPostJson } from '../../daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../fakeClaude';
import { reserveAvailablePort } from '../../network/reserveAvailablePort';
import { repoRootDir } from '../../paths';
import { readTrackedRunnerPid } from '../../providers/harness/daemonRunnerContinuity';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../providers/scenarios/sessionRuntime';
import { startExistingUiWebExport } from '../../process/uiWeb';
import { resolveTsxImportHookSpecifier } from '../../process/tsxImportHook';
import { encryptDataKeyBase64 } from '../../rpcCrypto';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { fetchSessionV2 } from '../../sessions';
import { readDecryptedSessionMetadataV2 } from '../../sessionHandoffMetadata';
import { type SocketCollector } from '../../socketClient';
import { waitFor } from '../../timing';
import { buildAuthBootstrapStorageSnapshot } from '../../uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../uiE2e/readLegacyAuthSecretFromLocalStorage';
import { createSessionFromNewSessionComposer } from '../../uiE2e/createSessionFromNewSessionComposer';
import { spawnSessionFromDaemon } from '../../uiE2e/spawnSessionFromDaemon';
import { sessionListRowTestId } from '../../uiE2e/sessionListRowTestId';
import { resolveCanonicalServerIdForUi } from '../../uiE2e/sessionFoldersDrag';
import { readStressConfig } from '../config/readStressConfig';
import { seedPerfProfile } from '../scenarios/seedPerfProfile';
import { perfFixtureId } from '../scenarios/perfProfile';
import { readServiceMetricsViaNodeFetch } from '../scenarios/fullComposeScenarioSupport';
import { startStressTarget } from '../targets/startStressTarget';

const supportedJourneys = ['J1', 'J13', 'J4-stream', 'J5', 'J14', 'Stop'] as const;
type Journey = typeof supportedJourneys[number];
type JourneyStep = { op: string; path?: string; ms?: number };
type CaptureControl = { cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> } };

export function parsePerfJourneyArgs(args: readonly string[]) {
  const options = Object.fromEntries(args.map(arg => {
    const split = arg.indexOf('=');
    if (!arg.startsWith('--') || split < 0) throw new Error('Performance journey options must use --key=value');
    return [arg.slice(2, split), arg.slice(split + 1)];
  }));
  const journey = options.journey as Journey;
  if (!supportedJourneys.includes(journey)) throw new Error(`--journey must be ${supportedJourneys.join('|')}`);
  if (!['cold', 'warm'].includes(options.cache ?? '')) throw new Error('--cache=cold|warm is required');
  if (!['counts', 'timing'].includes(options.mode ?? '')) throw new Error('--mode=counts|timing is required');
  for (const key of ['repo-root', 'ui-export-dir', 'out']) if (!options[key]) throw new Error(`--${key} is required`);
  const seed = Number(options.seed ?? 42);
  const heapCycles = Number(options['heap-cycles'] ?? 0);
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
  if (!Number.isSafeInteger(heapCycles) || heapCycles < 0 || (heapCycles > 0 && (options.mode !== 'counts' || journey !== 'J4-stream'))) throw new Error('Heap cycles require J4-stream counts and a nonnegative integer');
  return { journey, cache: options.cache!, mode: options.mode!, seed, heapCycles,
    repoRoot: resolve(options['repo-root']!), uiExportDir: resolve(options['ui-export-dir']!), out: resolve(options.out!) };
}

type PerfJourneyOptions = ReturnType<typeof parsePerfJourneyArgs>;

/** The pipeline sends public options only; credentials are created by the owned fixture. */
export function parsePerfJourneyRequest(input: unknown): Array<PerfJourneyOptions & { side: 'baseline' | 'candidate' }> {
  if (!input || typeof input !== 'object' || !('bases' in input) || !input.bases || typeof input.bases !== 'object'
    || !('runs' in input) || !Array.isArray(input.runs) || !input.runs.length) throw new Error('Performance request requires bases and runs');
  const bases = input.bases;
  const outputs = new Set<string>();
  let seed: number | undefined;
  return input.runs.map((run: unknown) => {
    if (!run || typeof run !== 'object' || !('side' in run) || (run.side !== 'baseline' && run.side !== 'candidate')) throw new Error('Invalid performance source side');
    const side = run.side;
    const base: unknown = Reflect.get(bases, side);
    if (!base || typeof base !== 'object' || !('repoRoot' in base) || typeof base.repoRoot !== 'string'
      || !('uiExportDir' in base) || typeof base.uiExportDir !== 'string') throw new Error(`Performance ${side} base is unavailable`);
    const keys = ['journey', 'mode', 'cache', 'seed', 'out', 'heapCycles'] as const;
    const values = Object.fromEntries(keys.map(key => [key, Reflect.get(run, key)])) as Record<typeof keys[number], unknown>;
    for (const key of ['journey', 'mode', 'cache', 'out'] as const) if (typeof values[key] !== 'string') throw new Error(`Performance run requires ${key}`);
    if (typeof values.seed !== 'number' || !Number.isSafeInteger(values.seed)) throw new Error('Performance run requires an integer seed');
    if (values.heapCycles !== undefined && (typeof values.heapCycles !== 'number' || !Number.isSafeInteger(values.heapCycles))) throw new Error('Invalid heap cycles');
    const options = parsePerfJourneyArgs([`--repo-root=${base.repoRoot}`, `--ui-export-dir=${base.uiExportDir}`,
      `--journey=${values.journey}`, `--mode=${values.mode}`, `--cache=${values.cache}`, `--seed=${values.seed}`, `--out=${values.out}`,
      ...(values.heapCycles === undefined ? [] : [`--heap-cycles=${values.heapCycles}`])]);
    if (outputs.has(options.out)) throw new Error('Performance runs must have distinct output directories');
    outputs.add(options.out);
    if (seed !== undefined && options.seed !== seed) throw new Error('Performance captures must share a seed');
    seed = options.seed;
    return { ...options, side };
  });
}

async function preparePerfJourneyEnvironment(options: PerfJourneyOptions, cleanup: Array<() => Promise<unknown>>, fixtures: string[], signal: AbortSignal) {
  // A comparison source must own its dependency tree; a node_modules symlink
  // into a live checkout would make baseline/candidate execution share state.
  const source = await realpath(options.repoRoot);
  const dependencies = relative(source, await realpath(join(source, 'node_modules')));
  if (dependencies === '..' || dependencies.startsWith(`..${sep}`) || isAbsolute(dependencies)) {
    throw new Error('Performance source dependencies must belong to the private comparison tree');
  }
  // Disposable Account keys, Docker state and browser runtime stay outside uploaded evidence.
  const fixtureDir = await mkdtemp(join(tmpdir(), 'happier-perf-journey-'));
  fixtures.push(fixtureDir);
  const workspaceDir = join(fixtureDir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = readStressConfig();
  if (config.targetMode === 'external' || config.compose.reuseRunningTopology) throw new Error('Performance journeys require a fresh owned full-compose target');
  const target = await startStressTarget({
    testDir: fixtureDir, repoRoot: options.repoRoot, captureSqlStatements: true,
    config: { ...config, targetMode: 'full-compose', flakeRetry: false,
      orchestration: { ...config.orchestration, expectedApiReplicas: 1, expectedWorkerReplicas: 1 },
      compose: { ...config.compose, apiReplicas: 1, workerReplicas: 1, reuseRunningTopology: false },
      artifacts: { ...config.artifacts, keepTopologyOnFailure: false } },
  });
  cleanup.push(() => target.stop());
  signal.throwIfAborted();
    const ui = await startExistingUiWebExport({ testDir: fixtureDir, distDir: options.uiExportDir,
      env: { ...process.env, EXPO_PUBLIC_HAPPIER_SERVER_URL: target.baseUrl, EXPO_PUBLIC_HAPPY_SERVER_URL: target.baseUrl } });
    cleanup.push(() => ui.stop());
    const auth = await createTestAuth(target.baseUrl);
    const serverId = await resolveCanonicalServerIdForUi(target.baseUrl);
    const cliHome = join(fixtureDir, 'cli-home');
    const seededCli = await seedCliAuthForTestAccount({ cliHome, serverUrl: target.baseUrl, auth, mode: 'dataKey' });
    const tsx = resolveTsxImportHookSpecifier();
    if (!tsx) throw new Error('Current performance driver tsx loader unavailable');
    const daemon = await startTestDaemon({ testDir: fixtureDir, happyHomeDir: cliHome,
        cliLaunchSpec: { command: process.execPath, args: ['--import', tsx, join(options.repoRoot, 'apps/cli/src/index.ts')], cwd: options.repoRoot,
          env: { TSX_TSCONFIG_PATH: join(options.repoRoot, 'apps/cli/tsconfig.json') } },
        env: { ...process.env, CI: '1', HAPPIER_HOME_DIR: cliHome, HAPPIER_SERVER_URL: target.baseUrl, HAPPIER_WEBAPP_URL: ui.baseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_VARIANT: 'dev', HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED: '0', CLAUDE_CONFIG_DIR: join(cliHome, '.claude'), CODEX_HOME: join(cliHome, '.codex'),
          TSX_TSCONFIG_PATH: join(options.repoRoot, 'apps/cli/tsconfig.json'), HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
      });
    cleanup.push(() => daemon.stop());
    const seeded = await seedPerfProfile({ baseUrl: target.baseUrl, auth, seed: options.seed,
      concurrency: config.load.mixedSetupConcurrency ?? 8, workspaceDir, liveMachineId: seededCli.machineId });
    return { workspaceDir, target, ui, auth, daemon, seeded, seededCli, serverId,
      footprintFixture: { dataset: seeded.summary, filesBackend: config.compose.filesBackend,
        dbConnectionLimit: config.compose.dbConnectionLimit ?? null, metricsEnabled: config.compose.metricsEnabled } };
}

async function capturePerfJourney(options: PerfJourneyOptions, environment: Awaited<ReturnType<typeof preparePerfJourneyEnvironment>>, signal: AbortSignal, cleanupFailures: unknown[]) {
  const { workspaceDir, target, ui, auth, daemon, seeded, seededCli, serverId, footprintFixture } = environment;
  const cleanup: Array<() => Promise<unknown>> = [];
  let phase = 'browser-start';
  try {
    signal.throwIfAborted();
    const streamSessions = seeded.sessions.filter(session => session.messageCount >= 500);
    await writeFile(join(options.out, 'dataset.json'), JSON.stringify(seeded.summary, null, 2) + '\n');
    const port = await reserveAvailablePort();
    const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    cleanup.unshift(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({ serverUrl: target.baseUrl, auth, mode: 'dataKey', storageScope: 'perf' }));
    const home = '[data-testid="home-header-start-new-session"], [data-testid="session-list-view-options-trigger"]';
    const homeReady = async () => {
      await page.locator(home).first().waitFor();
      await expect(page.getByTestId(sessionListRowTestId(serverId, streamSessions[0]!.sessionId))).toContainText(streamSessions[0]!.title);
    };
    const goHome = async () => { await page.goto(ui.baseUrl, { waitUntil: 'domcontentloaded' }); await homeReady(); };
    const prepare: JourneyStep[] = options.journey === 'J1' && options.cache === 'cold' ? [] : [{ op: 'open' }, { op: 'home' }];
    const steps: JourneyStep[] = options.journey === 'J1' ? [{ op: 'open' }, { op: 'home' }]
      : options.journey === 'J13' ? [{ op: 'idle', ms: 300_000 }]
      : options.journey === 'J4-stream' ? [{ op: 'stream-other' }, { op: 'stream-current' }, ...(options.heapCycles ? [{ op: 'heap-cycles' }] : [])]
      : [{ op: options.journey }];
    const collectors = new Map<string, SocketCollector>();
    if (options.journey === 'J4-stream') {
      for (const session of streamSessions.slice(0, 2)) {
        const binding = await createMachineBoundSessionScopedSocketCollector({ baseUrl: target.baseUrl, token: auth.token, sessionId: session.sessionId, machineId: session.machineId });
        collectors.set(session.sessionId, binding.socket); binding.socket.connect();
        await waitFor(() => binding.socket.isConnected(), { timeoutMs: 20_000, context: 'performance transcript publisher connection' });
        cleanup.unshift(async () => binding.socket.close());
      }
      prepare.push({ op: 'open-session' });
    }
    let stopSessionId: string | undefined;
    if (options.journey === 'Stop') {
      stopSessionId = await spawnSessionFromDaemon({ daemon, directory: workspaceDir, agent: 'claude' });
      await waitFor(async () => (await fetchSessionV2(target.baseUrl, auth.token, stopSessionId!)).active === true, { timeoutMs: 120_000, context: 'owned Stop fixture Session active before UI action' });
      prepare.push({ op: 'open-stop-session' });
    }
    const credentials = buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' });
    if (!('encryption' in credentials)) throw new Error('Performance fixture encryption unavailable');
    let approvalId: string | undefined;
    if (options.journey === 'J14') {
      const snapshot = buildAuthBootstrapStorageSnapshot({ serverUrl: target.baseUrl, auth, mode: 'dataKey', storageScope: 'perf' });
      approvalId = perfFixtureId(options.seed, 'approval', 0);
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: Date.now(), updatedAtMs: Date.now(),
        createdBy: { surface: 'cli' }, actionId: 'session.list', actionArgs: {}, summary: 'List fixture Sessions',
        executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: approvalId,
          surface: 'cli', serverId: snapshot.sessionStorage.activeServerId, actionId: 'session.list' } });
      await createEncryptedArtifactViaApi({ baseUrl: target.baseUrl, token: auth.token, artifactId: approvalId,
        headerJson: buildApprovalRequestArtifactHeaderV1(request), bodyJson: { body: JSON.stringify(request) }, cliAccessKey: credentials });
    }
    const admin = target.admin;
    if (!admin || !target.topology.composeProjectName) throw new Error('Owned full-compose observation capabilities unavailable');
    const containers = (await Promise.all(['api', 'worker'].map(service => admin.listServiceContainers(service)))).flat();
    const postgres = await admin.listServiceContainers('postgres');
    if (postgres.length !== 1) throw new Error('Owned PostgreSQL counter source unavailable');
    const { execFile } = await import('node:child_process');
    const images = await new Promise<string>((accept, reject) => execFile('docker',
      ['inspect', '--format', '{{.Image}}', ...containers.map(container => container.id)],
      (error, stdout) => error ? reject(error) : accept(stdout)));
    const imageIds = images.trim().split('\n');
    const observedContainers = containers.map((container, index) => ({ id: container.id, service: container.service, image: imageIds[index] }));
    const observerContext = { composeProjectName: target.topology.composeProjectName,
      uiDir: options.uiExportDir, containers: observedContainers, postgresContainerId: postgres[0]!.id, daemonPid: daemon.state.pid };
    const observerModule: unknown = await import(pathToFileURL(join(repoRootDir(), 'apps/stack/scripts/perf/stress-host.mjs')).href);
    const auditModule: unknown = await import(pathToFileURL(join(repoRootDir(), 'apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs')).href);
    if (!observerModule || typeof observerModule !== 'object' || !('createStressHostObserver' in observerModule) || typeof observerModule.createStressHostObserver !== 'function'
      || !auditModule || typeof auditModule !== 'object' || !('main' in auditModule) || typeof auditModule.main !== 'function') throw new Error('Canonical performance capture entry unavailable');
    const createObserver = observerModule.createStressHostObserver;
    const heap: { samples: Array<{ cycle: number; usedBytes: number; forcedGc: true }>; unavailable?: string } = { samples: [] };
    const runtime = {
      definition: { id: options.journey, readiness: 'Authenticated shell plus a decrypted populated Session row; not a claim that every fleet projection is hydrated', intent: options.journey === 'J1' ? 'Cold/warm startup through restoration of disposable persisted Account credentials'
        : options.journey === 'Stop' ? 'Session header Stop through the real UI Action and daemon; observe persisted inactive state'
        : 'Deterministic seeded full-compose performance contract', prepare, steps }, heap: options.heapCycles ? heap : undefined,
      outputDirectoryPrepared: true,
      startHostObserver: () => createObserver({ context: observerContext }),
      runStep: async (step: JourneyStep, captureContext: { capture: CaptureControl }) => {
        signal.throwIfAborted();
        if (step.op === 'open') { await page.goto(step.path ? new URL(step.path, ui.baseUrl).href : ui.baseUrl, { waitUntil: 'domcontentloaded' }); return true; }
        if (step.op === 'home') { await homeReady(); return true; }
        if (step.op === 'open-session' || step.op === 'open-stop-session') {
          const id = step.op === 'open-session' ? streamSessions[0]!.sessionId : stopSessionId!;
          await page.getByTestId(sessionListRowTestId(serverId, id)).click(); await page.getByTestId('transcript-chat-list').waitFor(); return true;
        }
        if (step.op === 'stream-other' || step.op === 'stream-current') {
          const session = streamSessions[step.op === 'stream-other' ? 1 : 0]!;
          const publisher = collectors.get(session.sessionId)!;
          const localId = `${options.journey}-${step.op}`;
          for (let segment = 0; segment < 20; segment++) {
            const value = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: localId,
              message: { content: [{ type: 'text', text: `Fixture stream ${step.op} ${'segment '.repeat(segment + 1)}` }] } } } };
            publisher.emit('transcript-stream-segment', { sid: session.sessionId, message: { localId, sidechainId: null,
              content: { t: 'encrypted', c: encryptDataKeyBase64(value, session.dataKey) }, createdAt: Date.now(), updatedAt: Date.now() } });
            await page.waitForTimeout(50);
          }
          if (step.op === 'stream-current') { await expect(page.getByTestId('transcript-chat-list')).toContainText('Fixture stream stream-current'); await page.getByTestId('transcript-chat-list').evaluate(node => { node.scrollTop = 0; }); }
          return true;
        }
        if (step.op === 'heap-cycles') {
          await page.goBack(); await page.locator(home).first().waitFor();
          const origin = await page.evaluate(() => performance.timeOrigin);
          for (let cycle = 0; cycle <= options.heapCycles; cycle++) {
            if (cycle) { await page.getByTestId(sessionListRowTestId(serverId, streamSessions[0]!.sessionId)).click(); await page.getByTestId('transcript-chat-list').waitFor(); await page.goBack(); await homeReady(); }
            if (await page.evaluate(() => performance.timeOrigin) !== origin) { heap.unavailable = 'Navigation crossed document lifetime; samples cannot establish retained growth'; break; }
            try {
              await captureContext.capture.cdp.send('HeapProfiler.collectGarbage');
              const usage = await captureContext.capture.cdp.send('Runtime.getHeapUsage');
              if (typeof usage.usedSize !== 'number') { heap.unavailable = 'Post-GC heap observation unavailable'; break; }
              heap.samples.push({ cycle, usedBytes: usage.usedSize, forcedGc: true });
            } catch { heap.unavailable = 'Browser forced-GC observation unavailable'; break; }
          }
          return true;
        }
        if (step.op === 'J5') { await createSessionFromNewSessionComposer({ page, uiBaseUrl: ui.baseUrl, machineId: seededCli.machineId, agentId: 'claude', prompt: 'Describe the deterministic fixture.', readiness: 'first-turn-reload-safe' }); return true; }
        if (step.op === 'J14') {
          await page.goto(new URL('/inbox', ui.baseUrl).href, { waitUntil: 'domcontentloaded' });
          await page.getByTestId(`inbox.approval.${approvalId}`).click();
          await page.getByTestId('approvals.approve').click();
          await waitFor(async () => { const artifact = await fetchArtifactViaApi({ baseUrl: target.baseUrl, token: auth.token, artifactId: approvalId! });
            const body = decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body: string }>({ encryptedJsonBase64: artifact.body, dataEncryptionKeyBase64: artifact.dataEncryptionKey, cliAccessKey: credentials });
            if (!body) return false; const request = ApprovalRequestV2Schema.parse(JSON.parse(body.body));
            if (request.status === 'failed') throw new Error('Owned Inbox approval execution failed');
            return request.status === 'executed'; }, { timeoutMs: 120_000, context: 'exact performance approval effect completion' });
          return true;
        }
        if (step.op === 'Stop') {
          await page.getByTestId('session-header-action-menu-trigger').click();
          await page.getByTestId('dropdown-option-ui_session_stop').click();
          await waitFor(async () => (await fetchSessionV2(target.baseUrl, auth.token, stopSessionId!)).active === false, { timeoutMs: 120_000, context: 'stopped fixture Session inactive' }); return true;
        }
        return false;
      },
    };
    if (options.cache === 'warm') await goHome();
    phase = 'canonical-journey-capture';
    await auditModule.main(['journey', options.journey, `--session=perf-${process.pid}`, `--cdp=http://127.0.0.1:${port}`, `--url=${ui.baseUrl}`,
      `--home-selector=${home}`, `--cache=${options.cache}`, '--ui-mode=export', `--capture-mode=${options.mode}`, `--out=${options.out}`], runtime);
    const bundle = JSON.parse(await readFile(join(options.out, 'bundle.json'), 'utf8')) as { status?: string };
    if (bundle.status === 'FAILED') throw new Error('Canonical performance journey failed');
    if (options.journey !== 'J4-stream' || options.mode !== 'counts') return;

    // The caller runs this after the browser and transcript publishers close,
    // so their activity never enters the process windows or the web capture.
    return async () => {
      const observer = await createObserver({ context: observerContext }).catch(() => null);
      if (!observer) {
        signal.throwIfAborted();
        await writeFile(join(options.out, 'bundle.json'), JSON.stringify({ ...bundle, footprint: { workload: null, phases: {} } }, null, 2) + '\n');
        return;
      }
      const sessions: string[] = [];
      const sessionAccess = { baseUrl: target.baseUrl, token: auth.token };
      const daemonAccess = { port: daemon.state.httpPort, controlToken: daemon.state.controlToken };
      const startFootprintSession = async () => {
        const sessionId = await spawnSessionFromDaemon({ daemon, directory: workspaceDir, agent: 'claude', request: { terminal: { mode: 'plain' } } });
        sessions.push(sessionId);
        const runnerPid = await readTrackedRunnerPid({ daemon: daemon.state, sessionId });
        const { selectedSecret, selectedUsesDataKeyVariant } = await readDecryptedSessionMetadataV2({
          ...sessionAccess, sessionId, machineKeys: [auth.accountMachineKey],
        });
        if (!selectedSecret || !selectedUsesDataKeyVariant) throw new Error('Footprint Session data key unavailable');
        return { ...sessionAccess, sessionId, runnerPid, secret: selectedSecret, encryptionVariant: 'dataKey' as const };
      };
      try {
        const footprint: unknown = await observer.captureFootprint({
          fixture: footprintFixture, signal,
          startSession: startFootprintSession,
          runTurn: async (session: Awaited<ReturnType<typeof startFootprintSession>>, turn: number) => {
            signal.throwIfAborted();
            await enqueueSessionPromptForScenario({ ...session, text: 'Describe the deterministic footprint fixture.' });
            await waitForAssistantMessageContaining({ ...session, requiredSubstring: 'FAKE_CLAUDE_OK_' + turn, timeoutMs: 30_000 });
          },
          readServerHeap: async (role: 'api' | 'worker') => {
            const metrics = await readServiceMetricsViaNodeFetch(target, role);
            const value = metrics.match(/^runtime_heap_used_bytes ([0-9]+)$/m)?.[1];
            return value === undefined ? null : Number(value);
          },
        });
        await writeFile(join(options.out, 'bundle.json'), JSON.stringify({ ...bundle, footprint }, null, 2) + '\n');
      } finally {
        const stopped = await Promise.allSettled(sessions.map(async sessionId => {
          const result = await daemonControlPostJson<{ status: string }>({ ...daemonAccess, path: '/stop-session', body: { sessionId } });
          if (result.status !== 200 || !['stopped', 'requested', 'not_found'].includes(result.data.status)) throw new Error('Footprint Session cleanup failed');
          await waitFor(async () => (await fetchSessionV2(target.baseUrl, auth.token, sessionId)).active === false,
            { timeoutMs: 30_000, context: 'stopped footprint Session inactive' });
        }));
        await observer.stop();
        if (stopped.some(result => result.status === 'rejected')) throw new Error('Footprint Session cleanup failed');
      }
    };
  } catch (error) {
    await writeFile(join(options.out, 'scenario-failure.json'), JSON.stringify({ phase, status: 'FAILED',
      error: error instanceof Error ? error.name : 'UnknownError', note: 'Sensitive subprocess and Account diagnostics are suppressed' }) + '\n');
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const stop of cleanup) { try { await stop(); } catch (error) { failures.push(error); } }
    cleanupFailures.push(...failures);
    if (failures.length) throw new AggregateError(failures, 'Performance journey cleanup failed');
  }
}

/** One owned seeded target per source side; captures retain the pipeline's interleaved order. */
export async function runPerfJourney(args: readonly string[]): Promise<void> {
  const runs = args.length === 1 && args[0]!.startsWith('--request-file=')
    ? parsePerfJourneyRequest(JSON.parse(await readFile(resolve(args[0]!.slice('--request-file='.length)), 'utf8')))
    : [{ ...parsePerfJourneyArgs(args), side: 'candidate' as const }];
  const environments = new Map<string, Awaited<ReturnType<typeof preparePerfJourneyEnvironment>>>();
  const cleanup: Array<() => Promise<unknown>> = [];
  const fixtures: string[] = [];
  const failures: unknown[] = [];
  const interrupted = new AbortController();
  const onSignal = () => interrupted.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const started: PerfJourneyOptions[] = [];
  try {
    for (const options of runs) {
      interrupted.signal.throwIfAborted();
      await mkdir(options.out, { recursive: true, mode: 0o700 });
      started.push(options);
      let environment = environments.get(options.side);
      if (!environment) {
        try {
          environment = await preparePerfJourneyEnvironment(options, cleanup, fixtures, interrupted.signal);
        } catch (error) {
          await writeFile(join(options.out, 'scenario-failure.json'), JSON.stringify({ phase: 'environment-prepare', status: 'FAILED',
            error: error instanceof Error ? error.name : 'UnknownError', note: 'Sensitive subprocess and Account diagnostics are suppressed' }) + '\n');
          throw error;
        }
        environments.set(options.side, environment);
      }
      const captureFootprint = await capturePerfJourney(options, environment, interrupted.signal, failures);
      await captureFootprint?.();
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    // A failed stop retains the fixture for diagnosis instead of deleting state
    // beneath a still-running owned resource.
    for (const stop of cleanup.reverse()) {
      try { await stop(); } catch (error) { failures.push(error); }
    }
    if (!failures.length) await Promise.all(fixtures.map(directory => rm(directory, { recursive: true, force: true })));
    await Promise.all(started.map(options => writeFile(join(options.out, 'scenario-cleanup.json'), JSON.stringify({
      status: failures.length ? 'FAILED' : 'CLEANED', ownedEnvironments: environments.size,
      failures: failures.map(() => 'Owned resource cleanup failed; sensitive diagnostics suppressed'),
    }) + '\n')));
    if (failures.length) throw new AggregateError(failures, 'Performance suite cleanup failed');
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'runPerfJourney.ts') {
  void runPerfJourney(process.argv.slice(2)).catch(() => { console.error('Performance journey failed; inspect owned output artifacts. Sensitive diagnostics suppressed.'); process.exitCode = 1; });
}
