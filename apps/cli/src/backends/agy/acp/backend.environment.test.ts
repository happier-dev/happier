import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

import { createAgyAcpBackend } from './backend';
import { installPinnedAgyAcpServerFixture, withIsolatedHappierHome } from './pinnedAgyAcpServer.testkit';

afterEach(() => vi.unstubAllEnvs());

describe('Antigravity ACP selected-account process environment', () => {
  it.each([true, false])('isolates endpoint/project overrides only for a selected account (selected: %s)', async selected => {
    await withIsolatedHappierHome(async dir => {
      vi.stubEnv('AGY_ACP_CCPA_BASE_URL', 'https://inherited.invalid');
      vi.stubEnv('AGY_ACP_CCPA_PROJECT', 'inherited-project');
      const capturePath = join(dir, 'captured.json');
      const source = `#!${process.execPath}
        const fs = require('node:fs');
        const readline = require('node:readline');
        fs.writeFileSync(process.env.AGY_TEST_CAPTURE_PATH, JSON.stringify({
          endpoint: process.env.AGY_ACP_CCPA_BASE_URL ?? null, project: process.env.AGY_ACP_CCPA_PROJECT ?? null,
          preserved: process.env.AGY_TEST_SHELL_CONFIG, google: process.env.GOOGLE_CLOUD_PROJECT
        }));
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          const result = request.method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'test' };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `;
      // Connected accounts launch the pinned server; native login launches the agy CLI.
      await installPinnedAgyAcpServerFixture(source);
      const agy = writeAcpTestAgentScript({ dir, fileName: 'capture.cjs', source });
      await chmod(agy, 0o755);
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy,
        AGY_TEST_CAPTURE_PATH: capturePath, AGY_TEST_SHELL_CONFIG: 'preserved', GOOGLE_CLOUD_PROJECT: 'unrelated-project',
        // Explicit environment overlays must not restore the selected account's inherited override.
        AGY_ACP_CCPA_BASE_URL: 'https://overlay.invalid', AGY_ACP_CCPA_PROJECT: 'overlay-project',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify(selected ? [{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }] : []),
      } });
      try {
        await backend.startSession();
        expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
          endpoint: selected ? null : 'https://overlay.invalid', project: selected ? null : 'overlay-project',
          preserved: 'preserved', google: 'unrelated-project',
        });
      } finally { await backend.dispose(); }
    });
  });
});
