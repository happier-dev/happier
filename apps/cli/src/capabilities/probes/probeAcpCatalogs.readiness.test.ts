import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '@happier-dev/agents';
import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import { agent as agyEntry } from '@/backends/agy';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { probeAcpCatalogs } from './probeAcpCatalogs';

const CONNECTED_ACCOUNT_ENV = {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }]),
};

async function discover(entryPoint: 'catalog' | 'backend' | 'session', home: string, env: NodeJS.ProcessEnv) {
  if (entryPoint === 'catalog') {
    return await probeAcpCatalogs({ agentId: 'agy', cwd: home, timeoutMs: 10_000, processEnv: env });
  }
  const { backend } = await createCatalogAcpBackend('agy', { cwd: home, env, readinessOnly: entryPoint === 'backend' });
  try {
    return await backend.startSession();
  } finally {
    await backend.dispose();
  }
}

describe('ACP catalog prerequisite readiness', () => {
  it.each([
    ...(['catalog', 'backend', 'session'] as const).map((entryPoint) => ({ entryPoint, account: 'machine login', env: {} })),
    ...(['catalog', 'backend', 'session'] as const).map((entryPoint) => ({ entryPoint, account: 'connected account', env: CONNECTED_ACCOUNT_ENV })),
  ])('requires the agy CLI for the $account at $entryPoint', async ({ entryPoint, env }) => {
    await withTempDir('happier-agy-readiness-', async (home) => {
      await expect(discover(entryPoint, home, { ...env, HAPPIER_AGY_PATH: join(home, 'missing-agy') }))
        .rejects.toThrow('Agy CLI (agy) is unavailable');
    });
  });
});

describe('Antigravity ACP capability launch', () => {
  // The scripted stand-in is launched through its shebang, which Windows cannot execute.
  it.skipIf(process.platform === 'win32')('probes the interactive agy CLI ACP server', async () => {
    await withTempDir('happier-agy-capability-', async (home) => {
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
    });
  });
});
