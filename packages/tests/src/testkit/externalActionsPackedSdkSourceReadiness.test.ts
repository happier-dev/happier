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
});
