import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';

const execFileAsync = promisify(execFile);

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

type CopiedCodexActivationProbeReport = Readonly<{
  ok: boolean;
  registryAccepted?: boolean;
  activatedBeforeDispatch?: boolean;
  activatedAfterDispatch?: boolean;
  runnerBootstrapPrepared?: boolean;
  registeredCodexPrerequisiteHooks?: ReadonlyArray<Readonly<{
    pluginId: string;
    localId: string;
  }>>;
  spawnResult?: Readonly<{
    ok: boolean;
    codexBackendMode?: string | null;
    errorCode?: string;
    errorMessage?: string;
  }>;
  failure?: Readonly<{
    name: string;
    message: string;
    stack?: string;
  }>;
  diagnostics?: unknown;
  logs?: unknown;
}>;

describe('core e2e: copied CLI source Codex plugin activation', () => {
  let testDir: string | null = null;

  afterEach(async () => {
    if (!testDir) return;
    await rm(testDir, { recursive: true, force: true });
    testDir = null;
  });

  it('activates and dispatches the bundled Codex prerequisite hook from the admitted copy snapshot', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'happier-copied-codex-activation-'));
    const happyHomeDir = resolve(testDir, 'home');
    const reportPath = resolve(testDir, 'copied-codex-activation-report.json');
    let launchSpec: Awaited<ReturnType<typeof resolveCliTestLaunchSpec>>;
    try {
      launchSpec = await resolveCliTestLaunchSpec(
        {
          testDir,
          env: {
            ...process.env,
            CI: '1',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
            // This probe consumes the canonical shared-deps publication; it must never become a competing writer.
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
          },
        },
        {
          repoRoot: repoRootDir(),
          snapshotDir: resolve(testDir, 'cli-source-snapshot'),
          preferSourceEntrypoint: true,
          skipDistIntegrityCheck: true,
          skipSourceFreshnessCheck: true,
        },
      );
    } catch (error) {
      const stdout = await readOptionalText(resolve(testDir, 'cli.sourceDevSharedDepsCheck.stdout.log'));
      const stderr = await readOptionalText(resolve(testDir, 'cli.sourceDevSharedDepsCheck.stderr.log'));
      throw new Error([
        `Copied CLI source snapshot preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        stdout ? `source-dev check stdout:\n${stdout}` : '',
        stderr ? `source-dev check stderr:\n${stderr}` : '',
      ].filter(Boolean).join('\n'));
    }

    if (!launchSpec.cwd) {
      throw new Error('Copied CLI source launch spec did not expose its immutable snapshot root');
    }
    const copiedProbeEntrypoint = resolve(
      launchSpec.cwd,
      'src',
      'plugins',
      'testkit',
      'copiedCodexActivationProbe.ts',
    );
    const probeArgs = [
      ...launchSpec.args.slice(0, -1),
      copiedProbeEntrypoint,
    ];

    let executionFailure: unknown = null;
    try {
      await execFileAsync(launchSpec.command, probeArgs, {
        cwd: launchSpec.cwd,
        env: {
          ...process.env,
          ...launchSpec.env,
          HAPPIER_HOME_DIR: happyHomeDir,
          HAPPIER_CODEX_ACTIVATION_PROBE_OUTPUT_PATH: reportPath,
        },
        timeout: 120_000,
      });
    } catch (error) {
      executionFailure = error;
    } finally {
      await launchSpec.cleanup?.();
    }

    const reportText = await readOptionalText(reportPath);
    if (!reportText) {
      throw new Error([
        'Copied Codex activation probe exited without publishing its report.',
        executionFailure instanceof Error
          ? executionFailure.stack ?? executionFailure.message
          : String(executionFailure),
      ].join('\n'));
    }
    const report = JSON.parse(reportText) as CopiedCodexActivationProbeReport;
    const failureContext = JSON.stringify({ executionFailure, report }, null, 2);

    expect(report.ok, failureContext).toBe(true);
    expect(report.registryAccepted, failureContext).toBe(true);
    expect(report.activatedBeforeDispatch, failureContext).toBe(false);
    expect(report.activatedAfterDispatch, failureContext).toBe(true);
    expect(report.runnerBootstrapPrepared, failureContext).toBe(true);
    expect(report.registeredCodexPrerequisiteHooks, failureContext).toEqual([{
      pluginId: 'happier.agent.codex',
      localId: 'resolve-prerequisites',
    }]);
    expect(report.spawnResult, failureContext).toEqual({
      ok: true,
      codexBackendMode: 'appServer',
    });
    expect(executionFailure, failureContext).toBeNull();
    // Snapshot publication can spend up to the CLI launcher's bounded copy/setup
    // interval before the probe receives its own 120-second process deadline.
  }, 300_000);
});
