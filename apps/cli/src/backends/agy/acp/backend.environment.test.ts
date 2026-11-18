import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

const mocks = vi.hoisted(() => ({ ensureAgyAcpServerForLaunch: vi.fn() }));
vi.mock('./ensureAgyAcpServerForLaunch', () => mocks);

import { createAgyAcpBackend } from './backend';

afterEach(() => vi.unstubAllEnvs());

describe('Antigravity ACP selected-account process environment', () => {
  it.each([true, false])('isolates endpoint/project overrides only for a selected account (selected: %s)', async selected => {
    await withTempDir('agy-selected-launch-env-', async dir => {
      vi.stubEnv('AGY_ACP_CCPA_BASE_URL', 'https://inherited.invalid');
      vi.stubEnv('AGY_ACP_CCPA_PROJECT', 'inherited-project');
      const capturePath = join(dir, 'captured.json');
      const script = writeAcpTestAgentScript({ dir, fileName: 'capture', source: `#!${process.execPath}
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
      ` });
      await chmod(script, 0o755);
      // Connected accounts launch the pinned server; native login launches the agy CLI.
      mocks.ensureAgyAcpServerForLaunch.mockResolvedValue({ command: script, args: [] });
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: script,
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
