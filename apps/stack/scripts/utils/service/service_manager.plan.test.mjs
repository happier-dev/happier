import assert from 'node:assert/strict';
import test from 'node:test';

import { planServiceAction } from './service_manager.mjs';

test('planServiceAction plans a systemd user install', () => {
  const plan = planServiceAction({
    backend: 'systemd-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    definitionPath: '/home/me/.config/systemd/user/dev.happier.selfhost.service',
    definitionContents: '[Unit]\nDescription=x\n',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, '/home/me/.config/systemd/user/dev.happier.selfhost.service');
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('daemon-reload')));
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('enable')));
});

test('planServiceAction plans a windows task install', () => {
  const plan = planServiceAction({
    backend: 'schtasks-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    taskName: 'Happier\\dev.happier.selfhost',
    definitionPath: 'C:\\\\Users\\\\me\\\\.happier\\\\services\\\\dev.happier.selfhost.ps1',
    definitionContents: 'Set-Location -LiteralPath "C:\\\\Users\\\\me"',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Create')));
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Run')));
});

