import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { AGENT_IDS } from '@happier-dev/agents';
import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import { agent as agyEntry } from '@/backends/agy';
import { configuration } from '@/configuration';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { probeAcpCatalogs } from './probeAcpCatalogs';

const CONNECTED_ACCOUNT_ENV = {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }]),
};

async function withIsolatedHappierHome(run: (home: string, downloadRequest: MockInstance) => Promise<void>): Promise<void> {
  // Patch the real OS HTTP adapter, including native ESM bindings in external dependencies.
  const downloadRequest = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected installation download'); });
  syncBuiltinESMExports();
  const home = await mkdtemp(join(tmpdir(), 'happier-agy-readiness-'));
  const keys = ['happyHomeDir', 'logsDir', 'settingsFile'] as const;
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
  Object.defineProperties(configuration, {
    happyHomeDir: { value: home, configurable: true },
    logsDir: { value: join(home, 'logs'), configurable: true },
    settingsFile: { value: join(home, 'settings.json'), configurable: true },
  });
  try {
    await run(home, downloadRequest);
  } finally {
    keys.forEach((key, index) => Object.defineProperty(configuration, key, descriptors[index]));
    downloadRequest.mockRestore();
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  }
}

function discover(entryPoint: 'catalog' | 'backend' | 'session', home: string, env: NodeJS.ProcessEnv) {
  return entryPoint === 'catalog'
    ? probeAcpCatalogs({ agentId: 'agy', cwd: home, timeoutMs: 10_000, processEnv: env })
    : createCatalogAcpBackend('agy', { cwd: home, env, ...(entryPoint === 'session' ? {} : { readinessOnly: true }) });
}

describe('ACP catalog prerequisite readiness', () => {
  it.each(['catalog', 'backend', 'session'] as const)('applies the managed prerequisite policy to connected accounts for %s', async (entryPoint) => {
    await withIsolatedHappierHome(async (home, downloadRequest) => {
      await expect(discover(entryPoint, home, CONNECTED_ACCOUNT_ENV)).rejects.toThrow(entryPoint === 'session'
        ? 'Unexpected installation download'
        : 'Agy ACP server is unavailable:');
      expect(downloadRequest).toHaveBeenCalledTimes(entryPoint === 'session' ? 1 : 0);
      if (entryPoint !== 'session') {
        await expect(readdir(join(home, 'tools', 'agy-acp-server'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  });

  it.each(['catalog', 'backend', 'session'] as const)('requires the agy CLI for native login without installing the pinned server for %s', async (entryPoint) => {
    await withIsolatedHappierHome(async (home, downloadRequest) => {
      await expect(discover(entryPoint, home, { HAPPIER_AGY_PATH: join(home, 'missing-agy') }))
        .rejects.toThrow('Agy CLI (agy) is unavailable');
      expect(downloadRequest).not.toHaveBeenCalled();
      await expect(readdir(join(home, 'tools', 'agy-acp-server'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('Antigravity ACP capability launch', () => {
  it('probes the interactive agy CLI ACP server without installing the pinned server', async () => {
    await withIsolatedHappierHome(async (home, downloadRequest) => {
      const argvPath = join(home, 'probe-argv.json');
      const methodsPath = join(home, 'probe-methods.jsonl');
      const interactivePath = join(home, 'agy');
      // A real scripted ACP process stands in for the vendor CLI at the OS boundary.
      await writeFile(interactivePath, String.raw`#!${process.execPath}
        const { writeFileSync, appendFileSync } = require('node:fs');
        writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const request = JSON.parse(line);
          appendFileSync(${JSON.stringify(methodsPath)}, JSON.stringify(request.method) + '\n');
          if (request.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: request.id,
              result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } },
            }) + '\n');
          }
        });
      `);
      await chmod(interactivePath, 0o755);
      const clis = Object.fromEntries(AGENT_IDS.map((id) => [id, { available: false }])) as DetectCliSnapshot['clis'];
      const context = {
        cliSnapshot: {
          path: null,
          clis: { ...clis, agy: { available: true, resolvedPath: interactivePath } },
          tmux: { available: false },
          windowsTerminal: { available: false },
        },
      };
      const getCapability = agyEntry.getCliCapabilityOverride;
      if (!getCapability) throw new Error('Expected the catalog ACP capability hook');
      const capability = await getCapability();
      const result = await capability.detect({
        request: { id: 'cli.agy', params: { includeAcpCapabilities: true } },
        context,
      });

      expect(result).toMatchObject({ available: true, resolvedPath: interactivePath, acp: { ok: true, loadSession: true } });
      expect(JSON.parse(await readFile(argvPath, 'utf8'))).toEqual(['acp']);
      expect((await readFile(methodsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual(['initialize']);
      expect(downloadRequest).not.toHaveBeenCalled();
      await expect(readdir(join(home, 'tools', 'agy-acp-server'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
