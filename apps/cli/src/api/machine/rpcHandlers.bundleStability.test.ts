import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('rpcHandlers bundle stability', () => {
  it('does not dynamically import fork-chain replay hydration (avoids dev rebuild breakage)', async () => {
    const rpcHandlersPath = fileURLToPath(new URL('./rpcHandlers.ts', import.meta.url));
    const text = await readFile(rpcHandlersPath, 'utf8');

    expect(text).not.toMatch(/import\([^)]*hydrateReplayDialogFromForkChain/);
  });
});
