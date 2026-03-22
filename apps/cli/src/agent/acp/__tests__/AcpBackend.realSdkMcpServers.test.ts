import { describe, expect, it } from 'vitest';

import { resolve } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

const ACP_STUB_PROVIDER_PATH = resolve(
  __dirname,
  '../../../../../../packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
);

describe('AcpBackend with real ACP SDK stub provider', () => {
  it('starts a session when MCP servers are included in the ACP session/new request', async () => {
    await withTempDir('happier-acp-real-sdk-mcp-', async (cwd) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd,
        command: process.execPath,
        args: [ACP_STUB_PROVIDER_PATH],
        mcpServers: {
          happier: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: { HAPPIER_MCP_TEST: '1' },
          },
        },
        transportHandler: createAcpTestTransportHandler({ initTimeoutMs: 1_000 }),
      });

      try {
        await expect(backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 15_000);
});
