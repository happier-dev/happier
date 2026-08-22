#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const fixtureRoot = join(repoRoot, 'packages/tests/fixtures/plugin-platform/agent-runtime-conformance');
const declarativeAcpFixtureRoot = join(
  repoRoot,
  'packages/tests/fixtures/plugin-platform/agent-runtime-acp-conformance',
);
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'vertical-b';
if (scenario !== 'vertical-b' && scenario !== 'foundation' && scenario !== 'declarative-acp') {
  throw new Error(
    'usage: run-agent-runtime-conformance.mjs --scenario <vertical-b|foundation|declarative-acp>',
  );
}

const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 240_000,
  });
  if (result.error) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
  }
  return result.stdout;
};

const tempRoot = await mkdtemp(join(tmpdir(), 'happier-native-agent-runtime-'));
const packRoot = join(tempRoot, 'pack');
const installRoot = join(tempRoot, 'install');
const happyHomeDir = join(tempRoot, 'home');
try {
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(happyHomeDir, { recursive: true }),
  ]);
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', packRoot], fixtureRoot);
  const archiveName = (await readdir(packRoot)).find((name) => (
    name.startsWith('happier-native-agent-runtime-conformance-') && name.endsWith('.tgz')
  ));
  if (!archiveName) throw new Error('native AgentRuntime fixture pack produced no archive');
  const archivePath = join(packRoot, archiveName);
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', packRoot], declarativeAcpFixtureRoot);
  const declarativeAcpArchiveName = (await readdir(packRoot)).find((name) => (
    name.startsWith('happier-declarative-acp-agent-runtime-conformance-') && name.endsWith('.tgz')
  ));
  if (!declarativeAcpArchiveName) {
    throw new Error('declarative ACP AgentRuntime fixture pack produced no archive');
  }
  const declarativeAcpArchivePath = join(packRoot, declarativeAcpArchiveName);
  await writeFile(join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'happier-native-agent-runtime-host',
    private: true,
    dependencies: {
      'happier-native-agent-runtime-conformance': `file:${archivePath}`,
      'happier-declarative-acp-agent-runtime-conformance': `file:${declarativeAcpArchivePath}`,
    },
  }, null, 2)}\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], installRoot);
  const installedPluginRoot = join(installRoot, 'node_modules', 'happier-native-agent-runtime-conformance');
  const installedManifest = JSON.parse(await readFile(
    join(installedPluginRoot, '.happier-plugin', 'plugin.json'),
    'utf8',
  ));
  if (installedManifest.id !== 'acme.native-runtime-proof') {
    throw new Error('packed native AgentRuntime fixture identity mismatch');
  }
  const installedDeclarativeAcpPluginRoot = join(
    installRoot,
    'node_modules',
    'happier-declarative-acp-agent-runtime-conformance',
  );
  const installedDeclarativeAcpManifest = JSON.parse(await readFile(
    join(installedDeclarativeAcpPluginRoot, '.happier-plugin', 'plugin.json'),
    'utf8',
  ));
  if (
    installedDeclarativeAcpManifest.id !== 'acme.declarative-acp-proof'
    || installedDeclarativeAcpManifest.entrypoints !== undefined
    || installedDeclarativeAcpManifest.contributes?.agents?.[0]?.runtime?.kind !== 'acp'
  ) {
    throw new Error('packed declarative ACP fixture must remain static and entrypoint-free');
  }

  const viteNodeCliPath = join(repoRoot, 'node_modules/vite-node/vite-node.mjs');
  const stdout = run(process.execPath, [
    viteNodeCliPath,
    '--root',
    join(repoRoot, 'apps/cli'),
    '--config',
    join(fixtureRoot, 'vite.config.mts'),
    join(fixtureRoot, 'host-probe.mts'),
  ], join(repoRoot, 'apps/cli'), {
    NODE_ENV: 'test',
    NODE_PATH: join(repoRoot, 'node_modules'),
    HAPPIER_AGENT_RUNTIME_PLUGIN_ROOT: installedPluginRoot,
    HAPPIER_AGENT_RUNTIME_HOME: happyHomeDir,
  });
  const reportLine = stdout.trim().split('\n').findLast((line) => line.startsWith('{'));
  if (!reportLine) throw new Error(`native AgentRuntime foundation produced no JSON report: ${stdout}`);
  const report = JSON.parse(reportLine);
  if (report.status !== 'foundation-passed') {
    throw new Error(`native AgentRuntime foundation failed: ${stdout}`);
  }
  if (
    report.mixedContributionActivation?.beforeAgentOpen !== true
    || report.mixedContributionActivation?.whileAgentActive !== true
    || report.mixedContributionActivation?.afterReload !== true
  ) {
    throw new Error('native AgentRuntime foundation did not prove safe-action activation before Agent open, while active, and after reload');
  }
  if (
    report.runtime?.nativeAdapterColdWatchReplay !== true
    || report.runtime?.hostColdWatchReplay !== true
    || report.runtime?.hostColdWatchReplayBlockedBy !== undefined
    || report.runtime?.exactTerminalEnforcement !== true
    || report.runtime?.exactTerminal !== true
    || report.runtime?.exactTerminalEnforcementBlockedBy !== undefined
    || report.runtime?.runtimeEndedHostSemantics !== true
    || report.runtime?.runtimeEndedHostSemanticsBlockedBy !== undefined
  ) {
    throw new Error('native AgentRuntime foundation must prove host cold replay, exact-terminal enforcement, and runtime-ended semantics');
  }
  if (
    report.processFoundation?.scope !== 'svc08-supervisor-only'
    || report.processFoundation?.authenticatedDaemonChildBridge !== false
    || report.processFoundation?.restart !== false
    || report.processFoundation?.blockedBy !== 'WS2.VB-HANDOFF'
  ) {
    throw new Error(
      'native AgentRuntime foundation must report the authenticated Runner Agent service and restart proof as blocked on WS2.VB-HANDOFF',
    );
  }
  if (
    report.queue?.batchDelivery !== false
    || report.queue?.blockedBy !== 'Pending Queue V2 V6'
  ) {
    throw new Error('native AgentRuntime foundation must report Queue batch delivery as blocked on Pending Queue V2 V6');
  }

  let declarativeAcpReport;
  if (scenario === 'vertical-b' || scenario === 'declarative-acp') {
    const declarativeAcpStdout = run(process.execPath, [
      viteNodeCliPath,
      '--root',
      join(repoRoot, 'apps/cli'),
      '--config',
      join(declarativeAcpFixtureRoot, 'vite.config.mts'),
      join(declarativeAcpFixtureRoot, 'host-probe.mts'),
    ], join(repoRoot, 'apps/cli'), {
      NODE_ENV: 'test',
      NODE_PATH: join(repoRoot, 'node_modules'),
      PATH: `${join(installRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
      HAPPIER_DECLARATIVE_ACP_PLUGIN_ROOT: installedDeclarativeAcpPluginRoot,
      HAPPIER_DECLARATIVE_ACP_HOME: join(happyHomeDir, 'declarative-acp'),
    });
    const declarativeAcpReportLine = declarativeAcpStdout
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{'));
    if (!declarativeAcpReportLine) {
      throw new Error(`declarative ACP AgentRuntime produced no JSON report: ${declarativeAcpStdout}`);
    }
    declarativeAcpReport = JSON.parse(declarativeAcpReportLine);
    if (
      declarativeAcpReport.status !== 'declarative-acp-passed'
      || declarativeAcpReport.plugin?.packed !== true
      || declarativeAcpReport.plugin?.staticManifest !== true
      || declarativeAcpReport.plugin?.daemonEntrypoint !== false
      || Object.values(declarativeAcpReport.runtime ?? {}).some((value) => value !== true)
    ) {
      throw new Error('packed declarative ACP AgentRuntime did not prove every required lifecycle case');
    }
  }
  process.stdout.write(`${JSON.stringify({
    ...report,
    ...(declarativeAcpReport ? { declarativeAcp: declarativeAcpReport } : {}),
    requestedScenario: scenario,
  })}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
