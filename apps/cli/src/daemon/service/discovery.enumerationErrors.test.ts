import { describe, expect, it, vi } from 'vitest';
const { readdirMock } = vi.hoisted(() => ({ readdirMock: vi.fn() }));
// Directory enumeration is an OS boundary; retain real definition parsing.
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readdir: readdirMock }));
import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
describe('daemon service inventory enumeration', () => {
  it('treats only missing directories as empty and propagates unreadable inventory', async () => {
    const params = { platform: 'linux', mode: 'user', userHomeDir: '/test', happierHomeDir: '/test/.happier', serversById: {} } as const;
    for (const code of ['EACCES', 'EIO']) {
      const error = Object.assign(new Error(code), { code });
      readdirMock.mockRejectedValue(error);
      await expect(discoverInstalledDaemonServiceEntries(params)).rejects.toMatchObject({ code: 'service_inventory_unavailable', cause: error });
    }
    readdirMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(discoverInstalledDaemonServiceEntries(params)).resolves.toEqual([]);
  });
});
