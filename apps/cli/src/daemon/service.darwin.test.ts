import { describe, expect, it } from 'vitest';

import { buildLaunchAgentPlistXml } from './service/darwin';

describe('daemon service (darwin) plist', () => {
  it('builds a user LaunchAgent plist that runs happier daemon start-sync', () => {
    const xml = buildLaunchAgentPlistXml({
      label: 'com.happier.cli.daemon',
      programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        HAPPIER_NO_BROWSER_OPEN: '1',
      },
      stdoutPath: '/Users/test/.happier/logs/daemon-service.out.log',
      stderrPath: '/Users/test/.happier/logs/daemon-service.err.log',
      workingDirectory: '/tmp',
    });

    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.happier.cli.daemon</string>');
    expect(xml).toContain('<key>ProgramArguments</key>');
    expect(xml).toContain('<string>/usr/local/bin/happier</string>');
    expect(xml).toContain('<string>daemon</string>');
    expect(xml).toContain('<string>start-sync</string>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>HAPPIER_NO_BROWSER_OPEN</key>');
  });

  it('preserves intentionally empty environment variable values', () => {
    const xml = buildLaunchAgentPlistXml({
      label: 'com.happier.cli.daemon',
      programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        EMPTY_VALUE: '',
      },
      stdoutPath: '/Users/test/.happier/logs/daemon-service.out.log',
      stderrPath: '/Users/test/.happier/logs/daemon-service.err.log',
      workingDirectory: '/tmp',
    });

    expect(xml).toContain('<key>EMPTY_VALUE</key>');
    expect(xml).toContain('<string></string>');
  });

  it('omits WorkingDirectory when no workingDirectory is provided', () => {
    const xml = buildLaunchAgentPlistXml({
      label: 'com.happier.cli.daemon',
      programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
      env: { PATH: '/usr/bin:/bin' },
      stdoutPath: '/Users/test/.happier/logs/daemon-service.out.log',
      stderrPath: '/Users/test/.happier/logs/daemon-service.err.log',
      workingDirectory: null,
    });

    expect(xml).not.toContain('<key>WorkingDirectory</key>');
  });

  it('escapes XML-sensitive characters in label and env values', () => {
    const xml = buildLaunchAgentPlistXml({
      label: 'com.happier.cli.daemon<&>"\'',
      programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
      env: {
        PATH: '/usr/bin:/bin',
        ESCAPED: `A&B<C>"'`,
      },
      stdoutPath: '/Users/test/.happier/logs/daemon-service.out.log',
      stderrPath: '/Users/test/.happier/logs/daemon-service.err.log',
      workingDirectory: '/tmp',
    });

    expect(xml).toContain('com.happier.cli.daemon&lt;&amp;&gt;&quot;&apos;');
    expect(xml).toContain('<key>ESCAPED</key>');
    expect(xml).toContain('<string>A&amp;B&lt;C&gt;&quot;&apos;</string>');
  });
});
