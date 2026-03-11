import { describe, expect, it } from 'vitest';

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

const ACP_STUB_PROVIDER_PATH = resolve(
  __dirname,
  '../../../../../../packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
);

describe('AcpBackend with real ACP SDK stub provider', () => {
  it('starts a session when MCP servers are included in the ACP session/new request', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-acp-real-sdk-mcp-'));
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
      transportHandler: {
        agentName: 'test',
        getInitTimeout: () => 1_000,
        getToolPatterns: () => [] as ToolPattern[],
      } satisfies TransportHandler,
    });

    try {
      await expect(backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
    } finally {
      await backend.dispose().catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
