import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeMcpStdioServerTools } from '../servers/probeMcpStdioServerTools';
import { resolveNodeBackedMcpServerCommand } from '../runtime/resolveNodeBackedMcpServerCommand';

describe('remote MCP authentication challenge through the real stdio probe', () => {
  it.each([
    { transport: 'http' as const, status: 401, challenge: 'Bearer resource_metadata="https://issuer.example.test/metadata"', code: 'mcp_sign_in_required' },
    { transport: 'sse' as const, status: 401, challenge: 'Bearer resource_metadata="https://issuer.example.test/metadata"', code: 'mcp_sign_in_required' },
    { transport: 'http' as const, status: 401, challenge: 'Basic realm="private"', code: 'mcp_tool_catalog_unavailable' },
    { transport: 'http' as const, status: 403, challenge: 'Bearer', code: 'mcp_tool_catalog_unavailable' },
  ])('preserves $transport HTTP $status $challenge as $code', async ({ transport, status, challenge, code }) => {
    let requests = 0;
    const remote = createServer((_request, response) => {
      requests++;
      response.writeHead(status, { 'WWW-Authenticate': challenge });
      response.end('private remote error');
    });
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    const root = await mkdtemp(join(tmpdir(), 'mcp-challenge-'));
    try {
      const path = join(root, 'bridge.json');
      await writeFile(path, JSON.stringify({ transport, url: `http://127.0.0.1:${address.port}/mcp`, headers: {} }));
      const invocation = await resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'], preferSourceEntrypoint: true,
      });
      await expect(probeMcpStdioServerTools({ config: { ...invocation,
        args: ['--conditions=happier-source', ...invocation.args],
        env: { ...invocation.env, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: path } },
      })).rejects.toMatchObject({ code, phase: 'connect' });
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
