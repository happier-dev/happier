import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { buildHappyCliSubprocessLaunchSpec, HappyCliImmutableRuntimeClosureError, resolveHappyCliSubprocessRuntimeDecision, spawnHappyCLI } from './spawnHappyCLI';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// The OS spawn is the only replaced boundary; invocation and custody planning stay real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(), spawn,
}));

describe('spawnHappyCLI process custody', () => {
  const envScope = createSpawnHappyCliEnvScope();
  afterEach(() => { envScope.restore(); spawn.mockReset(); });

  it('uses each concurrent hosted Session runtime, entrypoint, environment and working directory', async () => {
    spawn.mockImplementation(() => new ChildProcess());
    await withTempHappyCliEntrypoint(async hostEntrypoint => withTempHappyCliEntrypoint(async otherEntrypoint => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: hostEntrypoint });
      const inputs = [
        { runtime: 'node', entrypoint: hostEntrypoint, directory: '/session-a', marker: 'a' },
        { runtime: 'bun', entrypoint: otherEntrypoint, directory: '/session-b', marker: 'b' },
      ] as const;
      const specs = await Promise.all(inputs.map(input => runAddedHostedSession({
        environment: { NODE_ENV: 'test', HAPPIER_CLI_SUBPROCESS_RUNTIME: input.runtime,
          HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: input.entrypoint,
          HAPPIER_MANAGED_NODE_BIN: process.execPath, SESSION_MARKER: input.marker },
        workingDirectory: input.directory, end: () => {},
      }, async () => {
        await Promise.resolve();
        const spec = buildHappyCliSubprocessLaunchSpec(['--version']);
        spawnHappyCLI(['--version']);
        return spec;
      })));
      expect(specs.map(spec => ({ runtime: spec.runtime, entrypoint: spec.args.at(-2) }))).toEqual([
        { runtime: 'node', entrypoint: hostEntrypoint }, { runtime: 'bun', entrypoint: otherEntrypoint },
      ]);
      expect(spawn.mock.calls.map(call => ({ cwd: call[2]?.cwd, marker: call[2]?.env?.SESSION_MARKER }))).toEqual([
        { cwd: '/session-a', marker: 'a' }, { cwd: '/session-b', marker: 'b' },
      ]);
      expect(specs[0]?.filePath).toBe(process.execPath);
      expect(specs[1]?.filePath).toBe('bun');
      expect(buildHappyCliSubprocessLaunchSpec(['--version']).args).toContain(hostEntrypoint);
      spawnHappyCLI(['--version']);
      const hostOptions = spawn.mock.calls.at(-1)?.[2];
      expect({ cwd: hostOptions?.cwd, entrypoint: hostOptions?.env?.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT })
        .toEqual({ cwd: process.cwd(), entrypoint: hostEntrypoint });
      runAddedHostedSession({ environment: { NODE_ENV: 'test', HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: hostEntrypoint }, workingDirectory: '/session-c', end: () => {},
      }, () => spawnHappyCLI(['--version'], { cwd: '/explicit', env: { NODE_ENV: 'test', SESSION_MARKER: 'explicit' }, stdio: 'pipe' }, {
        environment: { NODE_ENV: 'test', HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: otherEntrypoint },
      }));
      const explicitCall = spawn.mock.calls.at(-1);
      expect({ filePath: explicitCall?.[0], args: explicitCall?.[1], cwd: explicitCall?.[2]?.cwd,
        marker: explicitCall?.[2]?.env?.SESSION_MARKER, stdio: explicitCall?.[2]?.stdio })
        .toEqual({ filePath: 'bun', args: [otherEntrypoint, '--version'], cwd: '/explicit', marker: 'explicit', stdio: 'pipe' });
    }));
  });

  it('uses each hosted Session runtime-backed decision while preserving explicit environment precedence', async () => {
    await withTempHappyCliEntrypoint(async entrypoint => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint });
      const decisions = await Promise.all(['1', '0'].map(value => runAddedHostedSession({
        environment: { NODE_ENV: 'test', HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: value, HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
          HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint }, workingDirectory: '/session', end: () => {},
      }, async () => {
        await Promise.resolve();
        let outcome: unknown;
        try { outcome = resolveHappyCliSubprocessRuntimeDecision(); } catch (error) { outcome = error; }
        expect(resolveHappyCliSubprocessRuntimeDecision({ environment: { NODE_ENV: 'test', HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0' } })).toBeNull();
        return outcome;
      })));
      expect(decisions[0]).toBeInstanceOf(HappyCliImmutableRuntimeClosureError);
      expect(decisions[1]).toBeNull();
    });
  });

  it('contains the resolved binary-safe CLI invocation in the service Job carrier', async () => {
    spawn.mockReturnValue(new ChildProcess());
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint });
      const custody = {
        executablePath: 'C:\\Happier\\happier-process-custody.exe',
        jobName: 'Local\\happier-background-worker', handshakePath: 'C:\\Temp\\worker-handshake.json',
      };
      const args = ['daemon', 'background-service-worker'];
      const resolved = buildHappyCliSubprocessLaunchSpec(args);
      spawnHappyCLI(args, { stdio: 'pipe' }, { processCustody: custody });
      expect(spawn.mock.calls[0]?.[0]).toBe(custody.executablePath);
      expect(spawn.mock.calls[0]?.[1]).toEqual([
        'run', `--job=${custody.jobName}`, `--handshake=${custody.handshakePath}`,
        '--', resolved.filePath, ...resolved.args,
      ]);
    });
  });
});
