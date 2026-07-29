import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertPackedManagedProviderCandidateDaemonRunning,
  cleanupPackedManagedProviderRuntimeResources,
  createPackedManagedProviderCandidateDaemonStartupError,
  readPackedManagedProviderRequestAuthCapability,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';

describe('packed managed Provider composed-runtime cleanup', () => {
  it('accepts the exact canonical V2 capability document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-managed-capability-'));
    const path = join(root, 'capability.json');
    const document = {
      v: 2 as const,
      materializationId: 'packed-materialization',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43_123,
    };
    try {
      await writeFile(path, JSON.stringify(document), 'utf8');

      await expect(
        readPackedManagedProviderRequestAuthCapability(path),
      ).resolves.toEqual(document);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'an unknown top-level field',
      {
        v: 2,
        materializationId: 'packed-materialization',
        subjectScopeDigest: 'a'.repeat(64),
        capability: 'A'.repeat(43),
        httpPort: 43_123,
        daemonId: 'legacy-split-owner',
      },
    ],
    [
      'a malformed capability',
      {
        v: 2,
        materializationId: 'packed-materialization',
        subjectScopeDigest: 'a'.repeat(64),
        capability: 'A'.repeat(42),
        httpPort: 43_123,
      },
    ],
    [
      'a noncanonical materialization id',
      {
        v: 2,
        materializationId: ' packed-materialization ',
        subjectScopeDigest: 'a'.repeat(64),
        capability: 'A'.repeat(43),
        httpPort: 43_123,
      },
    ],
    [
      'a materialization id above the 256-byte UTF-8 limit',
      {
        v: 2,
        materializationId: '😀'.repeat(65),
        subjectScopeDigest: 'a'.repeat(64),
        capability: 'A'.repeat(43),
        httpPort: 43_123,
      },
    ],
  ])('rejects a capability document with %s', async (_label, document) => {
    const root = await mkdtemp(join(tmpdir(), 'packed-managed-capability-'));
    const path = join(root, 'capability.json');
    try {
      await writeFile(path, JSON.stringify(document), 'utf8');

      await expect(
        readPackedManagedProviderRequestAuthCapability(path),
      ).rejects.toThrow(
        'packed_managed_provider_request_auth_capability_invalid',
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
      brokerProxy: null,
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
