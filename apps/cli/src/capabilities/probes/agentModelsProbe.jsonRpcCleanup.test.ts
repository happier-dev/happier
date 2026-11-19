import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { MUSE_PREFLIGHT_SESSION_CONTROLS } from '../../../../../packages/plugins/muse/src/agent/catalog';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { logger } from '@/ui/logger';

import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { createProbeTempDir } from './agentModelsProbe.testkit';

const model = { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark' };

it.runIf(process.platform === 'linux').each(['exit on EOF', 'survive EOF', 'reject model/list'] as const)(
  'settles a Muse JSON-RPC model probe when its child can %s', async (behavior) => {
    const { dir, cleanup } = await createProbeTempDir('muse-probe-cleanup');
    const script = join(dir, 'muse.cjs');
    const launches = join(dir, 'launches');
    const eof = join(dir, 'eof');
    await writeFile(script, `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
      process.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(eof)}, process.pid + '\\n'));
      if (${behavior !== 'exit on EOF'}) setInterval(() => {}, 1000);
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        const response = request.method === 'initialize' ? { result: { schema: { version: 1 } } }
          : ${behavior === 'reject model/list'} ? { error: { code: -32000, message: 'Catalog read failed' } }
          : { result: { models: [{ providerId: 'meta', modelId: 'muse-spark-1.3-contributor', displayLabel: 'Muse Spark' }] } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
      });
    `);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const executable = writeExecutableShimSync({ dir, fileName: 'muse',
      contents: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
    const catalogEntry = {
      id: 'muse', cliSubcommand: 'muse', vendorResumeSupport: 'unsupported' as const,
      ...projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'muse',
        systemTools: [{ id: 'muse-cli', title: 'Muse fixture', executableNames: [executable] }],
        preflightSessionControls: MUSE_PREFLIGHT_SESSION_CONTROLS,
        retirementSignal: new AbortController().signal, isCurrent: () => true,
      }),
    };
    // Reproduce native termination reporting a survivor. Only signal delivery to
    // these fixture children is suppressed. Census, RPC, EOF and wait are real.
    const kill = process.kill.bind(process);
    const survivors = new Set<number>();
    const signalDelivery = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal !== 0 && existsSync(launches) && readFileSync(launches, 'utf8').trim().split('\n').includes(String(pid))) {
        survivors.add(pid);
        return true;
      }
      return kill(pid, signal);
    });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    const processDiagnostics = vi.spyOn(logger, 'infoFile');
    try {
      const catalog = await probeAgentModelsBestEffort({ agentId: 'muse', catalogEntry, cwd: dir,
        env: { HAPPIER_MUSE_PATH: executable }, timeoutMs: 10_000 });
      if (behavior === 'reject model/list') {
        expect(catalog).toMatchObject({ source: 'unavailable', refreshError: true, availableModels: [] });
        expect((await readFile(eof, 'utf8')).trim()).toBe((await readFile(launches, 'utf8')).trim());
        expect(diagnostics).toHaveBeenCalledWith('[agent-preflight] JSON-RPC cleanup failed', {
          agentId: 'muse', phase: 'process_cleanup', code: 'plugin_exec_termination_incomplete', retryable: true,
        });
        return;
      }
      expect(catalog).toMatchObject({ source: 'dynamic', availableModels: expect.arrayContaining([expect.objectContaining(model)]) });
      expect(catalog.refreshError).toBeUndefined();
      const pids = (await readFile(launches, 'utf8')).trim().split('\n').map(Number);
      expect(pids).toHaveLength(1);
      expect(await readFile(eof, 'utf8')).toBe(`${pids[0]}\n`);
      if (behavior === 'exit on EOF') {
        expect(survivors.size).toBe(0);
        expect(() => kill(pids[0]!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } else {
        expect(survivors).toContain(pids[0]);
        expect(kill(pids[0]!, 0)).toBe(true);
        expect(processDiagnostics).toHaveBeenCalledWith('[process-tree] Owned process cleanup could not be verified', {
          code: 'plugin_exec_termination_incomplete', outcomes: ['survived'], reasons: [],
        });
        expect(diagnostics).toHaveBeenCalledWith('[agent-preflight] JSON-RPC cleanup failed', {
          agentId: 'muse', phase: 'process_cleanup', code: 'plugin_exec_termination_incomplete', retryable: true,
        });
      }
    } finally {
      processDiagnostics.mockRestore();
      diagnostics.mockRestore();
      signalDelivery.mockRestore();
      for (const pid of survivors) kill(pid, 'SIGKILL');
      await cleanup();
    }
  },
);
