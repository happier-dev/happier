import assert from 'node:assert/strict';
import test from 'node:test';

import { buildServiceDefinition } from './service_manager.mjs';

test('buildServiceDefinition renders a systemd user unit definition', () => {
  const def = buildServiceDefinition({
    backend: 'systemd-user',
    homeDir: '/home/me',
    spec: {
      label: 'dev.happier.selfhost',
      description: 'Happier Self-Host',
      programArgs: ['/home/me/.happier/self-host/bin/happier-server'],
      workingDirectory: '/home/me/.happier/self-host',
      env: { PORT: '3005' },
      stdoutPath: '/home/me/.happier/self-host/logs/server.out.log',
      stderrPath: '/home/me/.happier/self-host/logs/server.err.log',
    },
  });

  assert.equal(def.kind, 'systemd-service');
  assert.equal(def.path, '/home/me/.config/systemd/user/dev.happier.selfhost.service');
  assert.match(def.contents, /ExecStart=\/home\/me\/\.happier\/self-host\/bin\/happier-server/);
});

test('buildServiceDefinition renders a launchd user plist definition', () => {
  const def = buildServiceDefinition({
    backend: 'launchd-user',
    homeDir: '/Users/me',
    spec: {
      label: 'dev.happier.selfhost',
      description: 'Happier Self-Host',
      programArgs: ['/Users/me/.happier/self-host/bin/happier-server'],
      workingDirectory: '/Users/me/.happier/self-host',
      env: { PORT: '3005' },
      stdoutPath: '/Users/me/.happier/self-host/logs/server.out.log',
      stderrPath: '/Users/me/.happier/self-host/logs/server.err.log',
    },
  });

  assert.equal(def.kind, 'launchd-plist');
  assert.equal(def.path, '/Users/me/Library/LaunchAgents/dev.happier.selfhost.plist');
  assert.match(def.contents, /<key>Label<\/key>/);
  assert.match(def.contents, /dev\.happier\.selfhost/);
});

test('buildServiceDefinition renders a windows scheduled-task wrapper', () => {
  const def = buildServiceDefinition({
    backend: 'schtasks-user',
    homeDir: 'C:\\\\Users\\\\me',
    spec: {
      label: 'dev.happier.selfhost',
      description: 'Happier Self-Host',
      programArgs: ['C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\bin\\\\happier-server.exe'],
      workingDirectory: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host',
      env: { PORT: '3005' },
      stdoutPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\server.out.log',
      stderrPath: 'C:\\\\Users\\\\me\\\\.happier\\\\self-host\\\\logs\\\\server.err.log',
    },
  });

  assert.equal(def.kind, 'windows-wrapper-ps1');
  assert.match(def.path, /dev\.happier\.selfhost\.ps1$/);
  assert.match(def.contents, /\$env:PORT = "3005"/);
});

