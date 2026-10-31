import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { resolveGeminiAcpFlag } from './detect';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'Usage: gemini --experimental-acp', stderr: '' })),
}));

describe('Gemini ACP flag discovery', () => {
  it('reads the supported flag without creating a Windows console', () => {
    expect(resolveGeminiAcpFlag({ command: 'gemini.exe' })).toBe('--experimental-acp');
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.windowsHide).toBe(true);
  });
});
