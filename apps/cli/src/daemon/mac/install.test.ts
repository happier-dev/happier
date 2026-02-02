import { describe, expect, it } from 'vitest';

import { buildLaunchdPlistContent } from './install';

describe('mac daemon install plist', () => {
  it('uses Happier env vars and paths (no legacy Happy identifiers)', () => {
    const plist = buildLaunchdPlistContent({
      nodePath: '/usr/local/bin/node',
      scriptPath: '/tmp/install.js',
      homeDir: '/Users/test',
    });

    expect(plist).toContain('<key>HAPPIER_DAEMON_MODE</key>');
    expect(plist).toContain('/Users/test/.happier/daemon.log');
    expect(plist).toContain('/Users/test/.happier/daemon.err');
    expect(plist).toContain('<string>happier-daemon</string>');

    expect(plist).not.toContain('HAPPY_DAEMON_MODE');
    expect(plist).not.toContain('/.happy/');
    expect(plist).not.toContain('<string>happy-daemon</string>');
  });
});

