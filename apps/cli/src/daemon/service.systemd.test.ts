import { describe, expect, it } from 'vitest';

import { buildSystemdUserUnit } from './service/systemdUser';

describe('daemon service (linux) systemd user unit', () => {
  it('builds a systemd --user unit that runs happier daemon start-sync', () => {
    const unit = buildSystemdUserUnit({
      description: 'Happier CLI daemon',
      execStart: '/usr/local/bin/happier daemon start-sync',
      workingDirectory: '%h',
      env: {
        HAPPIER_NO_BROWSER_OPEN: '1',
      },
    });

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=Happier CLI daemon');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=/usr/local/bin/happier daemon start-sync');
    expect(unit).toContain('WorkingDirectory=%h');
    expect(unit).toContain('Environment=HAPPIER_NO_BROWSER_OPEN=1');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('[Install]');
  });

  it('rejects invalid environment variable keys', () => {
    expect(() =>
      buildSystemdUserUnit({
        description: 'Happier CLI daemon',
        execStart: '/usr/local/bin/happier daemon start-sync',
        env: {
          'HAPPIER BAD KEY': '1',
        },
      }),
    ).toThrow('Invalid systemd environment variable name');
  });

  it('rejects newline characters in unit header fields', () => {
    expect(() =>
      buildSystemdUserUnit({
        description: 'Happier CLI daemon\ninjected',
        execStart: '/usr/local/bin/happier daemon start-sync',
      }),
    ).toThrow('description must not contain newlines');

    expect(() =>
      buildSystemdUserUnit({
        description: 'Happier CLI daemon',
        execStart: '/usr/local/bin/happier daemon start-sync\ninjected',
      }),
    ).toThrow('execStart must not contain newlines');
  });

  it('escapes environment values with spaces, percent signs, and newlines', () => {
    const unit = buildSystemdUserUnit({
      description: 'Happier CLI daemon',
      execStart: '/usr/local/bin/happier daemon start-sync',
      env: {
        QUOTED: 'hello world',
        PERCENT: '100%',
        MULTILINE: 'line1\nline2',
      },
    });

    expect(unit).toContain('Environment=QUOTED="hello world"');
    expect(unit).toContain('Environment=PERCENT="100%%"');
    expect(unit).toContain('Environment=MULTILINE="line1\\nline2"');
  });

  it('omits WorkingDirectory line when unset', () => {
    const unit = buildSystemdUserUnit({
      description: 'Happier CLI daemon',
      execStart: '/usr/local/bin/happier daemon start-sync',
    });

    expect(unit).not.toContain('WorkingDirectory=');
  });
});
