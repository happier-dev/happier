import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectSwiftbarPluginInstalled,
  removeSwiftbarPlugins,
  resolveSwiftbarPluginsDir,
} from './swiftbar.mjs';

test('detectSwiftbarPluginInstalled treats matching symlinks as installed', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-'));
  try {
    const pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    const target = join(tmp, 'target.sh');
    const link = join(pluginsDir, 'hstack.5m.sh');
    await writeFile(target, '#!/bin/sh\necho ok\n', 'utf-8');
    await symlink(target, link);

    const detected = await detectSwiftbarPluginInstalled({
      pluginsDir,
      patterns: ['hstack.*.sh'],
      env: process.env,
    });
    assert.equal(detected.installed, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('removeSwiftbarPlugins removes matching symlink plugins', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-'));
  try {
    const pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    const target = join(tmp, 'target.sh');
    const link = join(pluginsDir, 'hstack.5m.sh');
    await writeFile(target, '#!/bin/sh\necho ok\n', 'utf-8');
    await symlink(target, link);

    const res = await removeSwiftbarPlugins({
      pluginsDir,
      patterns: ['hstack.*.sh'],
      env: process.env,
    });
    assert.equal(res.ok, true);
    assert.equal(res.removed, true);
    await assert.rejects(() => lstat(link), /ENOENT/i);
    const detected = await detectSwiftbarPluginInstalled({
      pluginsDir,
      patterns: ['hstack.*.sh'],
      env: process.env,
    });
    assert.equal(detected.installed, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveSwiftbarPluginsDir ignores override on non-darwin unless explicitly enabled', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-swiftbar-'));
  try {
    const pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_STACK_SWIFTBAR_PLUGINS_DIR: pluginsDir,
    };

    const resolved = await resolveSwiftbarPluginsDir({ env });
    if (process.platform === 'darwin') {
      assert.equal(resolved, pluginsDir);
    } else {
      assert.equal(resolved, null);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
