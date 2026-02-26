import { describe, expect, it, vi } from 'vitest';

describe('link-dev script (Windows npm shim)', () => {
  it('uses cmd.exe when resolving npm global bin dir on Windows', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }

      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      vi.resetModules();

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./link-dev.cjs') as {
        getGlobalBinDir?: (opts?: { execFileSync?: (...args: any[]) => any; existsSync?: (path: string) => boolean }) => string
      };
      expect(typeof mod.getGlobalBinDir).toBe('function');

      const execFileSync = vi.fn(() => 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\r\n');
      const dir = mod.getGlobalBinDir!({ execFileSync, existsSync: () => true });
      expect(typeof dir).toBe('string');
      expect(execFileSync).toHaveBeenCalled();
      const [command, args] = execFileSync.mock.calls[0] ?? [];
      expect(String(command).toLowerCase()).toContain('cmd');
      expect(args).toEqual(['/d', '/s', '/c', '"npm bin -g"']);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      vi.resetModules();
    }
  });
});
