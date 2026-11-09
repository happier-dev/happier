import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { probeAgentCliForInstall } from './cliSnapshot';

it('reaps a version probe descendant before caller cancellation settles', async ({ task }) => {
  await withTempDir('happier-version-probe-custody-', async dir => {
    const fixture = createDaemonizingProcessFixture(dir);
    const script = join(dir, 'version.cjs');
    await writeFile(script, fixture.args[1]!);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const command = writeExecutableShimSync({ dir,
      fileName: process.platform === 'win32' ? 'fixture-agent.cmd' : 'fixture-agent',
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    });
    const controller = new AbortController();
    const cancellation = new Error('Version probe cancelled');
    const probe = probeAgentCliForInstall({
      runtimeSpec: {
        id: 'fixture-agent', title: 'Fixture agent', binaryName: 'fixture-agent',
        sourcePreferenceDefault: 'system-first', managedInstall: null,
        manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
      },
      env: { ...process.env, HAPPIER_FIXTURE_AGENT_PATH: command }, signal: controller.signal,
    });
    void probe.catch(() => undefined);
    try {
      const pid = await fixture.ready({ launch: probe, timeoutMs: task.timeout });
      controller.abort(cancellation);
      await expect(probe).rejects.toBe(cancellation);
      expect(await waitForProcessExit(pid, { timeoutMs: 2_000 })).toBe(true);
    } finally {
      controller.abort(cancellation);
      await fixture.release();
      await fixture.cleanup();
      await Promise.allSettled([probe]);
    }
  });
}, 60_000);
