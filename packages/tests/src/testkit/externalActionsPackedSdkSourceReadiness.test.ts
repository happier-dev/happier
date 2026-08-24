import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from './paths';

describe('packed SDK external Actions E2E source readiness', () => {
  it('freezes the CLI launch candidate before disposable Account-server setup and transfers it to the daemon', async () => {
    const source = await readFile(resolve(
      repoRootDir(),
      'packages/tests/suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
    ), 'utf8');

    const resolveIndex = source.indexOf('await resolveCliTestLaunchSpec(');
    const serverIndex = source.indexOf('server = await startServerLight(');
    const ownershipTransferIndex = source.indexOf('pendingDaemonLaunchSpec = null;', serverIndex);
    const daemonIndex = source.indexOf('daemon = await startTestDaemon(');

    expect(resolveIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBeGreaterThan(resolveIndex);
    expect(ownershipTransferIndex).toBeGreaterThan(serverIndex);
    expect(daemonIndex).toBeGreaterThan(ownershipTransferIndex);
    expect(source.slice(daemonIndex, daemonIndex + 500)).toContain('cliLaunchSpec: daemonLaunchSpec');
    expect(source).toContain('.then(() => pendingDaemonLaunchSpec?.cleanup?.())');
    const candidatePreparation = source.slice(resolveIndex, serverIndex);
    expect(candidatePreparation).toContain(
      "HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy'",
    );
    expect(candidatePreparation).toContain(
      "HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '0'",
    );
    expect(candidatePreparation).toContain(
      "HAPPY_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '0'",
    );
    expect(candidatePreparation).not.toContain('skipSourceFreshnessCheck: true');
  });

  it('keeps first-class CLI and raw Action HTTP probes inside the prepared live candidate', async () => {
    const source = await readFile(resolve(
      repoRootDir(),
      'packages/tests/suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
    ), 'utf8');

    const daemonIndex = source.indexOf('daemon = await startTestDaemon(');
    const cliFlowIndex = source.indexOf('await runFirstClassCliSessionFlow(');
    const serverRawProbeIndex = source.indexOf('const serverRawBackends = await requestRawExternalAction(');
    const daemonRawProbeIndex = source.indexOf('const daemonRawBackends = await requestRawExternalAction(');
    const serverStopIndex = source.indexOf('await server.stop();');

    expect(daemonIndex).toBeGreaterThan(-1);
    expect(cliFlowIndex).toBeGreaterThan(daemonIndex);
    expect(serverRawProbeIndex).toBeGreaterThan(cliFlowIndex);
    expect(daemonRawProbeIndex).toBeGreaterThan(serverRawProbeIndex);
    expect(serverStopIndex).toBeGreaterThan(daemonRawProbeIndex);

    const cliFlow = source.slice(cliFlowIndex, serverRawProbeIndex);
    expect(cliFlow).toContain('cliLaunchSpec: daemonLaunchSpec');
    expect(cliFlow).toContain('serverUrl: server.baseUrl');
    expect(cliFlow).toContain('token: primaryPat.token');
    expect(cliFlow).toContain('machineId: seeded.machineId');

    const serverRawProbe = source.slice(serverRawProbeIndex, daemonRawProbeIndex);
    expect(serverRawProbe).toContain('token: primaryPat.token');
    expect(serverRawProbe).toContain("actionId: 'agents.backends.list'");
    expect(serverRawProbe).toContain("target: { kind: 'machine', machineId: seeded.machineId }");

    const daemonRawProbe = source.slice(daemonRawProbeIndex, serverStopIndex);
    expect(daemonRawProbe).toContain('token: primaryPat.token');
    expect(daemonRawProbe).toContain("actionId: 'agents.backends.list'");
    expect(daemonRawProbe).toContain('input: { includeDisabled: true }');
    expect(daemonRawProbe).not.toContain("target: { kind: 'machine'");
    expect(source).toContain('EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1');
  });

  it('keeps the generated packed driver syntax-safe while the one CLI flow proves stream cancellation plus compact, JSONL, and delegated PAT contracts', async () => {
    const source = await readFile(resolve(
      repoRootDir(),
      'packages/tests/suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
    ), 'utf8');

    const driverStart = source.indexOf('async function writePackedSdkDriver(');
    const driverEnd = source.indexOf('async function installPackedSdkConsumer(', driverStart);
    const cliFlowStart = source.indexOf('async function runFirstClassCliSessionFlow(');
    const cliFlowEnd = source.indexOf('async function requestRawExternalAction(', cliFlowStart);

    expect(driverStart).toBeGreaterThan(-1);
    expect(driverEnd).toBeGreaterThan(driverStart);
    expect(cliFlowStart).toBeGreaterThan(-1);
    expect(cliFlowEnd).toBeGreaterThan(cliFlowStart);

    const driver = source.slice(driverStart, driverEnd);
    const driverLines = driver.split(/\r?\n/u).map((line) => line.trim());
    const cleanupStart = driverLines.indexOf("'    } finally {',");
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(driverLines.slice(cleanupStart, cleanupStart + 4)).toEqual([
      "'    } finally {',",
      "'      await session.stop();',",
      "'    }',",
      "'  } else {',",
    ]);
    expect(driverLines[cleanupStart + 1]).not.toBe("'    } finally {',");
    expect(driver).toContain("machine.runs.startStream(");
    expect(driver).toContain("await iterator.return();");
    expect(driver).toContain('execution.run.start');

    const cliFlow = source.slice(cliFlowStart, cliFlowEnd);
    expect(cliFlow).toContain('parseSingleJsonRecord');
    expect(cliFlow).toContain("['history', '--help']");
    expect(cliFlow).toContain("'cli-first-class-history-compact'");
    expect(cliFlow).toContain("'cli-first-class-delegate'");
    expect(cliFlow).toContain("'--api-token'");
    expect(cliFlow).toContain('const uniqueSessionPrefix');
    expect(cliFlow).toContain('uniqueSessionPrefix,');
    expect(source).toContain('...consumer.logPaths');
  });

  it('uses the exact release candidate tarball and runs the packaged basic example across both public origins', async () => {
    const source = await readFile(resolve(
      repoRootDir(),
      'packages/tests/suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
    ), 'utf8');

    const installStart = source.indexOf('async function installPackedSdkConsumer(');
    const basicExampleStart = source.indexOf('async function runPackedSdkBasicExample(', installStart);
    const candidateModeStart = source.indexOf('const sdkCandidateTarballPath = resolveReleaseValidationSdkTarball();');
    const serverExampleStart = source.indexOf("logPrefix: 'server-shipped-basic-example'", candidateModeStart);
    const localExampleStart = source.indexOf("logPrefix: 'local-shipped-basic-example'", serverExampleStart);

    expect(source).toContain('HAPPIER_RELEASE_VALIDATION_SDK_TARBALL');
    expect(installStart).toBeGreaterThan(-1);
    expect(basicExampleStart).toBeGreaterThan(installStart);
    expect(candidateModeStart).toBeGreaterThan(basicExampleStart);
    expect(serverExampleStart).toBeGreaterThan(candidateModeStart);
    expect(localExampleStart).toBeGreaterThan(serverExampleStart);

    const install = source.slice(installStart, basicExampleStart);
    expect(install).toContain('params.sdkCandidateTarballPath ??');
    expect(install).toContain('exportPackSandboxTarball');

    const basicExample = source.slice(basicExampleStart, source.indexOf('function createFakeClaudeSessionTurnSentinel', basicExampleStart));
    expect(basicExample).toContain("'examples'");
    expect(basicExample).toContain("'basic'");
    expect(basicExample).toContain("'index.ts'");
    expect(basicExample).toContain("'--import'");

    const candidateExamples = source.slice(candidateModeStart, source.indexOf('const cliFakeClaudeSentinel', candidateModeStart));
    expect(candidateExamples).toContain("endpointMode: 'server'");
    expect(candidateExamples).toContain("endpointMode: 'daemon'");
    expect(candidateExamples).toContain('if (consumer.sdkCandidateTarballPath)');
  });
});
