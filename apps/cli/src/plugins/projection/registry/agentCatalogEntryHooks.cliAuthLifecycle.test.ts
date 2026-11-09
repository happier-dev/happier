import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { projectAgentCliAuthCatalogEntry } from './agentCatalogEntryHooks';

describe('background Agent auth process custody', () => {
  it.for(['completion', 'deadline', 'daemon-stop'] as const)('leaves zero children after three probes reach %s', async (end, { task }) => {
    await withTempDir('happier-auth-probe-custody-', async dir => {
      const retirement = new AbortController();
      const runtime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
      const executable = writeExecutableShimSync({ dir,
        fileName: process.platform === 'win32' ? 'auth.cmd' : 'auth',
        contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" %*\r\n`
          : `#!/bin/sh\nexec ${runtime} "$@"\n`,
      });
      const fixtures = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
        const root = join(dir, String(index));
        await mkdir(root);
        return createDaemonizingProcessFixture(root);
      }));
      const children: number[] = [];
      const probes: Promise<unknown>[] = [];
      try {
        for (const fixture of fixtures) {
          const projected = projectAgentCliAuthCatalogEntry({
            agentId: 'opencode', pluginId: 'fixture.auth', isCurrent: () => !retirement.signal.aborted,
            retirementSignal: retirement.signal,
            cli: {
              executable: { binaryName: 'auth', sourcePreference: 'system-first' },
              install: { managed: null, manual: { kind: 'none' } },
              auth: { support: 'status_only', nonInteractiveStatusProbe: true, loginLaunches: [] },
            },
            systemTools: [{ id: 'auth', title: 'Auth fixture', executableNames: [executable] }],
            hostAccess: { required: [{ id: 'auth-process', capability: 'process', reason: 'Probe native auth',
              scope: { executables: [{ kind: 'systemTool', id: 'auth' }] } }], optional: [] },
            cliAuth: { async detectAuthStatus(context) {
              await context.runDeclaredSystemToolCommand({ toolId: 'auth', args: fixture.args });
              return { state: 'unknown', reason: 'probe_failed' };
            } },
          });
          const spec = await projected.getCliAuthSpec?.();
          const probe = spec!.detectAuthStatus!({ resolvedPath: executable, timeoutMs: end === 'deadline' ? 5_000 : task.timeout });
          probes.push(probe);
          children.push(await fixture.ready({ launch: probe, timeoutMs: task.timeout }));
          if (end === 'completion') { await fixture.release(); await probe; }
        }
        if (end === 'daemon-stop') retirement.abort();
        if (end === 'deadline') await Promise.all(probes);
        const exited = await Promise.all(children.map(pid => waitForProcessExit(pid, { timeoutMs: 2_000 })));
        expect(exited.filter(value => !value)).toHaveLength(0);
        await Promise.all(probes);
      } finally {
        retirement.abort();
        await Promise.all(fixtures.map(async fixture => { await fixture.release(); await fixture.cleanup(); }));
        await Promise.allSettled(probes);
      }
    });
  }, 60_000);
});
