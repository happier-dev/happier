import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServiceCommandEnv } from './manager';

describe('buildServiceCommandEnv', () => {
  const originalSudoUid = process.env.SUDO_UID;

  afterEach(() => {
    if (originalSudoUid == null) {
      delete process.env.SUDO_UID;
    } else {
      process.env.SUDO_UID = originalSudoUid;
    }
    vi.restoreAllMocks();
  });

  it('targets the invoking user XDG_RUNTIME_DIR when root runs systemctl --user under sudo', () => {
    process.env.SUDO_UID = '501';
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);

    const env = buildServiceCommandEnv({
      cmd: 'systemctl',
      args: ['--user', 'status', 'happier-daemon.default.service'],
      env: {},
    });

    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/501');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/501/bus');
  });
});
