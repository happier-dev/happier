import { describe, expect, it } from 'vitest';

import { withMcpTimeout } from './withMcpTimeout';

describe('withMcpTimeout', () => {
  it('rejects stalled MCP work at the owning lifecycle boundary', async () => {
    await expect(withMcpTimeout(new Promise(() => undefined), {
      timeoutMs: 5,
      label: 'mcp_startup_timeout',
    })).rejects.toThrow('mcp_startup_timeout');
  });
});
