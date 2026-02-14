import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSystemdServiceUnit } from './systemd_service_unit.mjs';

test('renderSystemdServiceUnit emits a minimal systemd unit with env + working dir', () => {
  const unit = renderSystemdServiceUnit({
    description: 'Happier Self-Host',
    execStart: '/home/me/.happier/self-host/bin/happier-server',
    workingDirectory: '/home/me/.happier/self-host',
    env: {
      PORT: '3005',
      HAPPIER_DB_PROVIDER: 'sqlite',
    },
    restart: 'on-failure',
    stdoutPath: '/home/me/.happier/self-host/logs/server.out.log',
    stderrPath: '/home/me/.happier/self-host/logs/server.err.log',
  });

  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /Description=Happier Self-Host/);
  assert.match(unit, /WorkingDirectory=\/home\/me\/\.happier\/self-host/);
  assert.match(unit, /ExecStart=\/home\/me\/\.happier\/self-host\/bin\/happier-server/);
  assert.match(unit, /Environment=PORT=3005/);
  assert.match(unit, /Environment=HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StandardOutput=append:\/home\/me\/\.happier\/self-host\/logs\/server\.out\.log/);
  assert.match(unit, /StandardError=append:\/home\/me\/\.happier\/self-host\/logs\/server\.err\.log/);
});

test('renderSystemdServiceUnit supports system mode User= lines', () => {
  const unit = renderSystemdServiceUnit({
    description: 'Happier Stack',
    execStart: '/opt/happier/bin/hstack start',
    workingDirectory: '%h',
    env: { HAPPIER_STACK_ENV_FILE: '%h/.happier/stacks/main/env' },
    restart: 'always',
    runAsUser: 'happier',
  });

  assert.match(unit, /\nUser=happier\n/);
});
