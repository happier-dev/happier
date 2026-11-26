import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import axios from 'axios';
import { afterAll, expect, it, onTestFinished, vi } from 'vitest';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ExecutionRunStartRequestBaseSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { reloadConfiguration } from '@/configuration';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { resolveExecutionRunRuntimeBackendTarget } from './backendTargets';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { applyExecutionRunChildSelection } from '../../../../../../ui/sources/components/sessions/runs/launcher/executionRunChildChoice';
import { ROBOREV_PLUGIN } from '../../../../../../../packages/plugins/review-panels/src/manifest';
import { CLAWPATCH_PLUGIN } from '../../../../../../../packages/plugins/review-slices/src/manifest';
import { GIT_PLUGIN } from '../../../../../../../packages/plugins/scm-git/src/manifest';
import { runWithRealGitScmRuntime } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import selectedNativeReview from '../../../../../../../packages/plugins/review-panels/src/agent/reviews/fixtures/selected-review.json';
import '@/agent/runtime/registry/engineRegistry/runtimeCore';

const home = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-native-review-login-'));
  const original = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = directory;
  return { directory, original };
});
const transport = vi.hoisted(() => ({ materialize: vi.fn(), release: vi.fn() }));
// Only daemon transport and physical persisted credentials are substituted.
// UI input projection, host selection, catalog hooks and registered adapters run real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization: transport.materialize,
  releaseExecutionRunConnectedServices: transport.release,
}));
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'native-review-fixture', encryption: null }),
}));

afterAll(async () => {
  await pluginReloadController.shutdown();
  if (home.original === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = home.original;
  reloadConfiguration();
  await rm(home.directory, { recursive: true, force: true });
});

it.each([
  { engineId: 'roborev', plugin: ROBOREV_PLUGIN, runner: 'codex' },
  { engineId: 'roborev', plugin: ROBOREV_PLUGIN, runner: 'claude' },
  { engineId: 'clawpatch', plugin: CLAWPATCH_PLUGIN, runner: 'codex' },
  { engineId: 'clawpatch', plugin: CLAWPATCH_PLUGIN, runner: 'claude' },
] as const)('runs explicit Machine $runner login through the registered $engineId host path', async ({ engineId, plugin, runner }) => runWithRealGitScmRuntime(async () => {
  const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-native-review-login-' });
  onTestFinished(() => rm(repository.rootPath, { recursive: true, force: true }));
  await writeFile(join(repository.rootPath, repository.trackedPath), 'reviewable change\n');
  const machineHome = join(repository.rootPath, 'machine-home');
  const codexHome = join(machineHome, '.codex');
  const claudeHome = join(machineHome, '.claude');
  const bin = join(repository.rootPath, 'fixture-bin');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(claudeHome, { recursive: true }), mkdir(bin)]);
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ fixtureLogin: 'machine-codex' }));
  await writeFile(join(claudeHome, 'settings.json'), JSON.stringify({ fixtureLogin: 'machine-claude' }));
  const callsPath = join(bin, 'calls.jsonl');
  const scriptPath = join(bin, 'native-review.cjs');
  const nativeReview = structuredClone(selectedNativeReview);
  nativeReview.structured_output.findings = [];
  // Physical external executables replace vendors, preserving the real Exec
  // resolver, spawn, environment inheritance and finite lifecycle beneath the host.
  await writeFile(scriptPath, `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const readLogin = (root, file) => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).fixtureLogin; } catch { return null; } };
// Native clawpatch isolates Claude by default; its documented host mode is required to consume Machine login.
const usesHostClaude = ${JSON.stringify(engineId)} !== 'clawpatch' || args[args.indexOf('--provider') + 1] !== 'claude' || process.env.CLAWPATCH_CLAUDE_AUTH_CONTEXT === 'host';
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  claudeHome: process.env.CLAUDE_CONFIG_DIR, codexLogin: readLogin(process.env.CODEX_HOME, 'auth.json'),
  claudeLogin: usesHostClaude ? readLogin(process.env.CLAUDE_CONFIG_DIR, 'settings.json') : null,
  hasAmbientCredential: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => Boolean(process.env[key])) }) + '\\n');
const output = value => process.stdout.write(JSON.stringify(value));
if (args.includes('--version')) process.stdout.write(${JSON.stringify(engineId === 'roborev' ? '0.75.0' : '0.8.4')});
else if (${JSON.stringify(engineId)} === 'roborev') {
  if (args[0] === 'job' && args[1] === 'list') output([{ id: 3 }]);
  else if (args[0] === 'job' && args[1] === 'show') output(${JSON.stringify(nativeReview)});
} else {
  const state = args[args.indexOf('--state-dir') + 1];
  if (args[0] === 'init') { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'project.json'), '{}'); output({ initialized: true }); }
  else if (args[0] === 'map') { fs.mkdirSync(path.join(state, 'features'), { recursive: true }); fs.writeFileSync(path.join(state, 'features', 'slice.json'), JSON.stringify({ schemaVersion: 1, featureId: 'slice', status: 'reviewed' })); output({ features: 1 }); }
  else if (args[0] === 'review') { fs.mkdirSync(path.join(state, 'runs'), { recursive: true }); fs.writeFileSync(path.join(state, 'runs', 'native-login.json'), JSON.stringify({ schemaVersion: 1, runId: 'native-login', status: 'completed', claimedFeatureIds: ['slice'], findingIds: [], errors: [] })); output({ run: 'native-login', reviewed: 1, findings: 0 }); }
  else process.exitCode = 23;
}
`);
  writeExecutableShimSync({ dir: bin, fileName: process.platform === 'win32' ? `${engineId}.cmd` : engineId,
    contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${scriptPath.replace(/'/g, `'\\''`)}' "$@"\n` });
  if (engineId === 'clawpatch') {
    const dependency = CLAWPATCH_PLUGIN.manifest.contributes?.managedDependencies?.find(item => item.id === 'review-executable');
    const source = dependency?.sources.find(item => item.kind === 'managedJavaScriptPackage');
    if (!dependency || source?.kind !== 'managedJavaScriptPackage') throw new Error('Expected pinned native package declaration');
    // Seed only the physical installed-package boundary, as the canonical
    // managedJavaScriptPackage adapter tests do; no installer or package download.
    const packageRoot = join(home.directory, 'tools', 'providers', source.installId, 'current', 'workspace', 'node_modules', source.packageName);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: source.packageName, version: source.version,
      bin: { [dependency.executable]: 'native-review.cjs' } }));
    await writeFile(join(packageRoot, 'native-review.cjs'), await readFile(scriptPath));
    vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
  }
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('HOME', machineHome);
  vi.stubEnv('USERPROFILE', machineHome);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
  for (const key of ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
  transport.materialize.mockReset().mockRejectedValue(new Error('Explicit Machine login must not acquire an Account'));
  transport.release.mockReset();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected fixture Home request'); }));
  vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
    if (availability) return availability;
    throw new Error('Unexpected fixture Home request');
  });
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    happyHomeDir: home.directory,
    runtimeOptions: { pluginIds: [plugin.manifest.id, GIT_PLUGIN.manifest.id, `happier.agent.${runner}`], agentIsolation: {
      requesterIdentity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'fixture-home',
        hostAccountAgent: { accountId: 'fixture-account', custodianAccountId: 'fixture-account',
          machineId: 'fixture-machine', installationId: 'fixture-installation' } }),
      read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
    } },
    plugins: [
      { manifest: plugin.manifest, replaceExisting: true, files: { '.happier-plugin-build/daemon.js': 'export function activate() {}',
        'resources/review-prompt.md': await readFile(new URL(`../../../../../../../packages/plugins/${engineId === 'roborev' ? 'review-panels' : 'review-slices'}/resources/review-prompt.md`, import.meta.url), 'utf8'),
      }, instantiateCommittedModule: () => ({ activate: plugin.activate }) },
      { manifest: GIT_PLUGIN.manifest, replaceExisting: true, files: { '.happier-plugin-build/daemon.js': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: GIT_PLUGIN.activate }) },
    ] });
  let bridge: ExecutionRunHostBridge | undefined;
  try {
    const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
    const identity = { pluginId: plugin.manifest.id, localId: engineId };
    const backendTarget = resolveExecutionRunRuntimeBackendTarget({ kind: 'agent', identity }, engineRegistry.contributions);
    if (!backendTarget) throw new Error('Native review target was not admitted');
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
      resolveAgentIdentity: id => engineRegistry.contributions.agentDefinitionsById.get(id)?.identity ?? null,
    });
    const runnerAgentTarget = { kind: 'agent' as const, identity: { pluginId: `happier.agent.${runner}`, localId: runner } };
    const selection = ReviewStartInputSchema.parse(applyExecutionRunChildSelection({ instructions: 'Review using Machine login',
      scope: engineId === 'roborev' ? 'changes' : 'repository', changeType: 'uncommitted', base: { kind: 'none' },
      reviewers: [{ kind: 'engine', engineId, runnerAgentTarget }],
      engines: { [engineId]: engineId === 'roborev' ? { panel: 'none' } : {} },
    }, { agentTargetKey: `agent:happier.agent.${runner}/${runner}`, providerConnectionId: null, modelId: 'machine-login-model' }));
    const reviewer = selection.reviewers[0];
    if (reviewer?.kind !== 'engine') throw new Error('Native reviewer selection missing');
    const sourceCustody = fixture.registry.readPluginSourceCustody?.(identity.pluginId);
    if (!sourceCustody) throw new Error('Native review source was not admitted');
    bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: repository.rootPath,
      happyHomeDir: home.directory, resolveAccountSettings: async () => ({}),
      sendAcp: async () => {}, resolveExecutionRunProfileCatalog: () => ({ profileCatalog, engineRegistry }) });
    const started = await bridge.start({ sessionId: null, intent: 'review', backendTarget,
      runnerAgentTarget: reviewer.runnerAgentTarget, modelSelection: reviewer.modelSelection,
      connectedServices: ExecutionRunStartRequestBaseSchema.shape.connectedServices.parse(reviewer.connectedServices),
      instructions: selection.instructions,
      profileId: `${identity.pluginId}/review`, profileSourceCustody: sourceCustody,
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming',
      resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
      intentInput: selection });
    await bridge.waitForTerminal(started.runId);
    const calls = (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
      args: string[]; home: string; codexHome: string; claudeHome: string; codexLogin: string; claudeLogin: string; hasAmbientCredential: boolean;
    });
    expect(bridge.getPublic(started.runId), JSON.stringify({ run: bridge.getPublic(started.runId), calls })).toMatchObject({ status: 'succeeded' });
    const review = calls.find(call => call.args[0] === 'review');
    expect(review).toMatchObject({ home: machineHome, codexHome, claudeHome,
      codexLogin: 'machine-codex', claudeLogin: 'machine-claude', hasAmbientCredential: false });
    expect(review?.args).toEqual(expect.arrayContaining([engineId === 'roborev' ? '--agent' : '--provider',
      engineId === 'roborev' && runner === 'claude' ? 'claude-code' : runner, '--model', 'machine-login-model']));
    expect(transport.materialize).not.toHaveBeenCalled();
    expect(vi.mocked(axios.get).mock.calls.map(([url]) => new URL(String(url)).pathname)
      .filter(path => path.includes('/connect/') || path.endsWith('/account/settings'))).toEqual([]);
  } finally { await bridge?.dispose(); await fixture.dispose(); }
}));
