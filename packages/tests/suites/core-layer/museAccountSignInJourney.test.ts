import { expect, it, onTestFinished } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol';
import { resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionTranscriptGetSemanticSuccessSchema } from '../../../protocol/src/actions/specs/session/transcript';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { writeExecutableShimSync } from '../../../../apps/cli/src/testkit/fs/executableShim';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { readMuseRecord } from '../../../plugins/muse/src/agent/events';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { buildUniversalPluginUiArtifacts } from '../../../plugin-sdk/src/ui/build/buildUniversalUiArtifacts';
import { sourcePluginUiBuildOptions } from '../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';

const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' } as const;

it('signs in Muse through the CLI Action, PostgreSQL Home and full daemon, then starts a contributor model with the chosen effort', async () => {
  const testDir = createRunDirs({ runLabel: 'muse-device' }).testDir('sign-in-to-native-turn');
  const waiting = new AbortController();
  onTestFinished(() => waiting.abort());
  const recording = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(recording.rows)) throw new Error('Native playback has no frames');
  const advanced = readMuseRecord(JSON.parse(await readFile(new URL('../../../plugins/muse/src/agent/testkit/fixtures/advanced.json', import.meta.url), 'utf8')));
  if (!Array.isArray(advanced.rows)) throw new Error('Captured native effort frames are absent');
  const nativeSessionId = recording.rows.map(frame => readMuseRecord(readMuseRecord(readMuseRecord(frame).message).result).session)
    .map(value => readMuseRecord(value).sessionId).find(value => typeof value === 'string');
  // Reuse the captured control envelopes used by runtime.configuration.test.ts.
  const modelFrames = advanced.rows.slice(123, 126).map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    const params = readMuseRecord(message.params);
    if (message.method === 'session/setModel') return { ...frame, message: { ...message,
      params: { ...params, model: { modelId: 'muse-spark-1.3-contributor', providerId: 'meta' } } } };
    if (message.method === 'session/modelChanged') return { ...frame, message: { ...message,
      params: { ...params, modelId: 'muse-spark-1.3-contributor' } } };
    return frame;
  });
  const effortFrames = advanced.rows.slice(113, 116).map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    const params = readMuseRecord(message.params);
    return message.method === 'session/setReasoningEffort' || message.method === 'session/reasoningEffortChanged'
      ? { ...frame, message: { ...message, params: { ...params, reasoningEffort: 'xhigh' } } } : frame;
  });
  const controlSessionId = readMuseRecord(readMuseRecord(readMuseRecord(effortFrames[0]).message).params).sessionId;
  if (typeof nativeSessionId !== 'string' || typeof controlSessionId !== 'string') throw new Error('Captured Session identity absent');
  recording.rows.push(...JSON.parse(JSON.stringify([...modelFrames, ...effortFrames])
    .replaceAll(JSON.stringify(controlSessionId), JSON.stringify(nativeSessionId))));
  const playbackSteps: { requestRow: number; receiveUntilRow: number }[] = [];
  for (let index = 0; index < recording.rows.length; index++) {
    const frame = readMuseRecord(recording.rows[index]);
    const message = readMuseRecord(frame.message);
    if (frame.direction !== 'send' || !['model/list', 'session/start', 'turn/start', 'session/setModel', 'session/setReasoningEffort'].includes(String(message.method))) continue;
    const nextSend = recording.rows.findIndex((row, next) => next > index && readMuseRecord(row).direction === 'send');
    playbackSteps.push({ requestRow: index, receiveUntilRow: nextSend === -1 ? recording.rows.length : nextSend });
  }
  const auditPath = join(testDir, 'muse-native-audit.json');
  const nativeScript = join(testDir, 'muse-device-native.cjs');
  await writeFile(nativeScript, [
    "const fs = require('node:fs'); const path = require('node:path');",
    "if (process.argv.includes('--version')) { console.log('1.4.15'); process.exit(0); }",
    "const auth = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'muse/auth.json'), 'utf8'));",
    // Native API-key mode is the captured contributor-model distinction. This
    // process refuses an ambient or hand-seeded credential before any playback.
    "if (auth.providers.meta.api_key !== 'synthetic-device-inference' || auth.providers.meta.access_token !== 'synthetic-device-oauth' || process.env.META_API_KEY !== 'synthetic-device-inference') process.exit(31);",
    `const playback = JSON.parse(${JSON.stringify(JSON.stringify(recording))});`,
    "for (const row of playback.rows) { const models = row.message?.result?.models; if (!Array.isArray(models)) continue; for (const id of ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']) { const base = models.find(model => model.modelId === id.replace('-contributor', '')); models.push({ ...base, modelId: id, displayLabel: id, isDefault: false }); } }",
    'process.env.MUSE_TEST_RECORDING = JSON.stringify(playback);',
    `process.env.MUSE_TEST_PLAYBACK_STEPS = ${JSON.stringify(JSON.stringify(playbackSteps))};`,
    `process.env.MUSE_TEST_AUDIT_PATH = ${JSON.stringify(auditPath)};`,
    MUSE_MSP_PLAYBACK_SCRIPT,
  ].join('\n'));
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const executable = writeExecutableShimSync({ dir: testDir, fileName: process.platform === 'win32' ? 'muse.cmd' : 'muse',
    contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${nativeScript}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeScript)} "$@"\n` });
  // The vendor dispatcher is installed before the real CLI starts. No internal
  // authentication host, Device grant or Account persistence owner is replaced.
  const vendorAuditPath = join(testDir, 'vendor-requests.jsonl');
  const vendorPreload = join(testDir, 'vendor-http-preload.mjs');
  const cliPackage = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url));
  await writeFile(vendorPreload, `import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const undici = createRequire(${JSON.stringify(cliPackage)})('undici');
const vendor = new undici.MockAgent();
vendor.disableNetConnect();
for (const [origin, path, body] of [
  ['https://auth.meta.com', '/oidc/device/authorization/', { device_code: 'synthetic-device', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.meta.com/device', expires_in: 600, interval: 0.001 }],
  ['https://auth.meta.com', '/oidc/device/token/', { access_token: 'synthetic-device-oauth', expires_in: 3600 }],
  ['https://api.meta.ai', '/muse-code/key', { api_key: 'synthetic-device-inference', base_url: 'https://api.meta.ai/v1', is_subs_active: true }],
]) vendor.get(origin).intercept({ path, method: 'POST' }).reply(200, () => {
  appendFileSync(${JSON.stringify(vendorAuditPath)}, JSON.stringify({ path }) + '\\n');
  return body;
}, { headers: { 'content-type': 'application/json' } }).persist();
const realFetch = undici.fetch;
undici.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return realFetch(input, ['auth.meta.com', 'api.meta.ai'].includes(url.hostname) ? { ...init, dispatcher: vendor } : init);
};`);
  // Account-host authentication loads the same portable graph as the app.
  // Source CLI launches do not prepare this ignored executable prerequisite.
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  await buildUniversalPluginUiArtifacts(join(repoRoot, 'packages/plugins/muse'), undefined,
    await sourcePluginUiBuildOptions({ repoRoot }));
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  onTestFinished(async () => { try { await fixture?.stop(); } finally { await postgres.stop(); } });
  fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
  const account = await fixture.createAccount('muse-device-owner');
  const capabilitySelection = { mcp: { managedServersEnabled: false, happierToolsEnabled: false,
    forceIncludeServerIds: [], forceExcludeServerIds: [] } };
  const machine = await fixture.enrollDaemon(account, { env: {
    NODE_OPTIONS: [fixture.sourceOptions, '--import', pathToFileURL(vendorPreload).href].join(' '),
    [resolveAgentCliOverrideEnvKey('muse')]: executable,
    META_API_KEY: 'synthetic-conflicting-ambient',
  } });
  const connectEnv = { ...process.env, CI: '1', HAPPIER_VARIANT: 'dev',
    HAPPIER_HOME_DIR: machine.homeDir, HAPPIER_SERVER_URL: fixture.actionServerApiUrl,
    HAPPIER_WEBAPP_URL: fixture.server.baseUrl, HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    NODE_OPTIONS: [fixture.sourceOptions, '--import', pathToFileURL(vendorPreload).href].join(' '),
  };
  const launch = await resolveCliTestLaunchSpec({ testDir, env: connectEnv },
    { snapshotDir: join(testDir, 'cli-connect'), preferSourceEntrypoint: true });
  onTestFinished(() => launch.cleanup?.());
  const connectOutput = join(testDir, 'cli.connect.stdout.log');
  await runLoggedCommand({ command: launch.command,
    args: [...launch.args, 'connect', 'muse-account', '--device', '--no-open', '--yes'],
    cwd: launch.cwd ?? testDir, env: { ...connectEnv, ...launch.env },
    stdoutPath: connectOutput, stderrPath: join(testDir, 'cli.connect.stderr.log'),
    timeoutMs: null, abortSignal: waiting.signal,
  });
  // Assert the vendor's actual challenge was presented, then obtain the newly
  // minted Account from Home rather than parsing an Account id from CLI prose.
  expect(await readFile(connectOutput, 'utf8')).toContain('ABCD-EFGH');
  const saved = await account.execute('connectedServices.accounts.list', { service });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
  if (!saved.ok) throw new Error('Signed-in Account was not persisted');
  const catalog = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list'].parse(saved.result);
  expect(catalog.accounts).toHaveLength(1);
  const connected = catalog.accounts[0]!.account;
  expect(connected).toMatchObject({ authenticationModeId: 'device', status: 'connected', ref: { service } });
  expect((await readFile(vendorAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line).path))
    .toEqual(['/oidc/device/authorization/', '/oidc/device/token/', '/muse-code/key']);
  const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
    [`${service.pluginId}/${service.localId}`]: { source: 'connected', profileId: connected.ref.accountId },
  } });
  const models = await account.execute('agents.models.list', {
    agentId: 'muse', machineId: machine.target.machineId,
    probe: { cwd: machine.workspaceDir, bypassCache: true, connectedServices: bindings },
  });
  expect(models, JSON.stringify(models)).toMatchObject({ ok: true });
  if (!models.ok) throw new Error('Signed-in Muse catalog Action failed');
  const listedModels = readMuseRecord(models.result).items;
  if (!Array.isArray(listedModels)) throw new Error('Muse catalog Action did not settle populated');
  expect(listedModels).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'meta/muse-wonder-1.0' }),
    expect.objectContaining({ id: 'meta/muse-spark-1.3' }),
    expect.objectContaining({ id: 'meta/muse-spark-1.2' }),
  ]));
  const chosen = listedModels.map(readMuseRecord).find(model => model.id === 'meta/muse-spark-1.3-contributor');
  if (typeof chosen?.id !== 'string') throw new Error('Contributor model is not selectable');
  const started = await account.execute('session.spawn_new', {
    executionTarget: machine.target,
    directory: { kind: 'path', path: machine.workspaceDir }, terminal: { mode: 'plain' },
    agentTarget: { kind: 'agent', identity: { pluginId: service.pluginId, localId: 'muse' } },
    connectedServices: bindings,
    modelSelection: { v: 1, updatedAt: 1, ref: resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId: chosen.id,
    })! },
    configuration: { model: { value: chosen.id, updatedAtMs: 1, selectionSource: 'explicit' }, mode: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: null, updatedAtMs: 0 }, options: { reasoning_effort: { value: 'xhigh', updatedAtMs: 1 } } },
    capabilitySelection,
    initialInput: { text: 'Reply with exactly PEBBLE. Do not use tools.' },
  });
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  if (!started.ok) throw new Error('Session spawn Action failed');
  const result = SessionSpawnNewActionResultV1Schema.parse(started.result);
  expect(result).toMatchObject({ type: 'success', initialInput: { status: 'accepted' } });
  if (result.type !== 'success') throw new Error('Session creation did not settle');
  const audit = await waitForMuseMspProcessAudit(auditPath, audit => audit.commandTargets.some(command => command.method === 'turn/start'),
    { signal: waiting.signal });
  expect(audit.modelSelections).toContainEqual({ providerId: 'meta', modelId: 'muse-spark-1.3-contributor' });
  const effortIndex = audit.commandTargets.findIndex(command => command.method === 'session/setReasoningEffort' && command.reasoningEffort === 'xhigh');
  expect(effortIndex).toBeGreaterThanOrEqual(0);
  expect(effortIndex).toBeLessThan(audit.commandTargets.findIndex(command => command.method === 'turn/start'));
  await expect.poll(async () => {
    const transcript = await account.execute('session.transcript.get', { sessionId: result.sessionId });
    if (!transcript.ok) throw new Error('Created Session transcript unavailable');
    return SessionTranscriptGetSemanticSuccessSchema.parse(transcript.result).items
      .some(item => item.role === 'assistant' && item.text === 'PEBBLE');
  }).toBe(true);
  expect((await readMuseMspProcessAudit(auditPath)).earlyTurnCount).toBe(0);
}, 0);
