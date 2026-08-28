import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertPackedManagedProviderCandidateDaemonRunning,
  cleanupPackedManagedProviderRuntimeResources,
  createPackedManagedProviderCandidateDaemonStartupError,
  writeCandidateHandoffProviderSource,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';

describe('packed managed Provider composed-runtime cleanup', () => {
  it('authors the full external Provider package through public Connected Account contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-public-provider-source-'));
    const pluginRoot = join(root, 'plugin');
    const executable = join(root, 'acme-packed-provider-runtime');
    try {
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, 'package.json'), `${JSON.stringify({
        name: '@acme/packed-public-provider',
        version: '0.0.0',
        type: 'module',
        files: ['dist'],
      })}\n`, 'utf8');
      await writeFile(executable, '#!/usr/bin/env node\n', 'utf8');
      await chmod(executable, 0o755);

      await writeCandidateHandoffProviderSource({
        pluginRoot,
        version: '1.0.0',
        generation: 'P',
        wrapperExecutable: executable,
      });

      const [source, manifestText] = await Promise.all([
        readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8'),
        readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
      ]);
      const manifest = JSON.parse(manifestText);
      expect(source).toContain("from '@happier-dev/plugin-sdk/connected-accounts'");
      expect(source).toContain('buildConnectedAccountRequestAuthClientSource');
      expect(source).toContain('lookupConnectedAccountRequestAuth({ purpose })');
      expect(source).toContain("'novel-cloud': {");
      expect(source).toContain("purpose: 'novel-upstream'");
      expect(source).not.toContain("purpose: 'openai-upstream'");
      expect(source).not.toContain("pluginId: 'happier.agent.codex'");
      expect(source).not.toMatch(/@happier-dev\/(?:protocol|agents)|apps\/cli|packages\/plugin-sdk/u);
      expect(manifest.contributes.connectedAccountDescriptors).toEqual([
        expect.objectContaining({ id: 'novel-cloud' }),
      ]);
      expect(manifest.contributes.providers[0].managedRuntime.connectedAccounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            purpose: 'novel-upstream',
            service: {
              pluginId: 'acme.packed-managed-public-provider',
              localId: 'novel-cloud',
            },
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops every acquired resource after an earlier stop fails', async () => {
    const events: string[] = [];
    const resource = (name: string, error?: Error) => ({
      stop: vi.fn(async () => {
        events.push(name);
        if (error) throw error;
      }),
    });

    await expect(cleanupPackedManagedProviderRuntimeResources({
      daemon: resource('daemon', new Error('daemon stop failed')),
      serverProxy: resource('server-proxy'),
      connectProxy: resource('connect-proxy'),
      server: resource('server'),
      stockPortObserver: resource('stock-port-observer'),
    })).rejects.toThrow('packed managed composed runtime cleanup failed');

    expect(events).toEqual([
      'daemon',
      'server-proxy',
      'connect-proxy',
      'server',
      'stock-port-observer',
    ]);
  });

  it('classifies candidate daemon exit before control readiness without process output', () => {
    expect(() => assertPackedManagedProviderCandidateDaemonRunning({
      exitCode: 1,
      signalCode: null,
    })).toThrow(
      'packed_managed_provider_candidate_daemon_exited_before_control_ready',
    );
    expect(() => assertPackedManagedProviderCandidateDaemonRunning({
      exitCode: null,
      signalCode: null,
    })).not.toThrow();
  });

  it('retains bounded redacted pre-state daemon diagnostics before cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-managed-daemon-diagnostics-'));
    const stdoutPath = join(root, 'daemon.stdout.log');
    const stderrPath = join(root, 'daemon.stderr.log');
    const stdoutSecret = 'stdout-secret-value';
    const stderrSecret = 'stderr-secret-value';
    const configSecret = 'config-secret-value';

    try {
      await writeFile(
        stdoutPath,
        `safe stdout line\nOPENAI_API_KEY=${stdoutSecret}\n`,
        'utf8',
      );
      await writeFile(
        stderrPath,
        `safe stderr line\nAuthorization: Bearer ${stderrSecret}\n`
        + `config={"opaque":"${configSecret}"}\n`,
        'utf8',
      );

      const failure =
        await createPackedManagedProviderCandidateDaemonStartupError({
          cause: new Error(
            'Daemon startup failed during waitForDaemonState: '
            + 'Daemon exited before writing daemon.state.json (code=1). '
            + 'phase=waitForDaemonState daemonStateEverWritten=no '
            + 'daemonStateEverRemoved=no daemonStateLastCandidateCount=0',
          ),
          stdoutPath,
          stderrPath,
        });

      expect(failure.message).toBe(
        'packed_managed_provider_candidate_daemon_exited_before_state',
      );
      expect(failure.packedManagedProviderFailureDiagnostics).toMatchObject({
        schemaVersion: 1,
        code: 'packed_managed_provider_candidate_daemon_exited_before_state',
        phase: 'waitForDaemonState',
        process: {
          exitCode: 1,
          signalCode: null,
        },
        daemonState: {
          everWritten: false,
          everRemoved: false,
          lastCandidateCount: 0,
        },
        logs: {
          stdout: {
            tail: expect.stringContaining('safe stdout line'),
          },
          stderr: {
            tail: expect.stringContaining('safe stderr line'),
          },
        },
      });
      const serialized = JSON.stringify(
        failure.packedManagedProviderFailureDiagnostics,
      );
      expect(serialized).not.toContain(stdoutSecret);
      expect(serialized).not.toContain(stderrSecret);
      expect(serialized).not.toContain(configSecret);
      expect(serialized).not.toContain(stdoutPath);
      expect(serialized).not.toContain(stderrPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not retain an unmarked secret suffix when the read limit cuts a sensitive line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-managed-daemon-diagnostics-'));
    const stdoutPath = join(root, 'daemon.stdout.log');
    const stderrPath = join(root, 'daemon.stderr.log');
    const secretTail = 'must-not-survive-window-truncation';

    try {
      await writeFile(
        stderrPath,
        `Authorization: Bearer ${'x'.repeat(9_000)}${secretTail}`,
        'utf8',
      );

      const failure =
        await createPackedManagedProviderCandidateDaemonStartupError({
          cause: new Error(
            'Daemon startup failed during waitForDaemonState: '
            + 'Daemon exited before writing daemon.state.json (code=1).',
          ),
          stdoutPath,
          stderrPath,
        });

      const serialized = JSON.stringify(
        failure.packedManagedProviderFailureDiagnostics,
      );
      expect(serialized).not.toContain(secretTail);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
