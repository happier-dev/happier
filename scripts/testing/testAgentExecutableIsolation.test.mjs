import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { createTestTempDirectory } from './process/temporaryDirectories.mjs';

// A subprocess models a fresh worker without modifying this runner's environment.
test('agent test setup excludes ambient PATH and Home executables but permits explicit fixtures', () => {
  const fixture = createTestTempDirectory('happier-agent-host-sentinel-');
  try {
    const bin = join(fixture.root, 'bin');
    mkdirSync(bin);
    const marker = join(fixture.root, 'invocations');
    const shim = join(bin, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
    writeFileSync(shim, process.platform === 'win32'
      ? `@echo off\r\necho invoked>>"${marker}"\r\n`
      : `#!/bin/sh\nprintf invoked >> '${marker}'\n`, { mode: 0o755 });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { installTestHomeEnvironment } from './scripts/testing/testHomeEnvironment.mjs';
      const home = installTestHomeEnvironment({ isolateExecutables: true });
      try {
        const invoke = command => spawnSync(command, ['--version'], { shell: process.platform === 'win32' });
        invoke('cursor-agent');
        assert.equal(existsSync(${JSON.stringify(marker)}), false, 'ambient cursor-agent was spawned');
        assert.equal(process.env.HAPPIER_CURSOR_PATH, undefined);
        assert.notEqual(process.env.HOME, ${JSON.stringify(fixture.root)});
        if (process.platform !== 'win32') {
          const platform = spawnSync('uname', ['-s'], { encoding: 'utf8' });
          assert.equal(platform.status, 0, 'guest platform probe must remain available');
          assert.ok(platform.stdout.trim());
        }
        const explicit = invoke(${JSON.stringify(shim)});
        assert.equal(explicit.status, 0, explicit.stderr?.toString());
        assert.equal(existsSync(${JSON.stringify(marker)}), true, 'explicit executable fixture must still run');
      } finally { home.cleanup(); }
    `], { encoding: 'utf8', env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root,
      HAPPIER_CURSOR_PATH: shim, PATH: [bin, process.env.PATH].join(delimiter) } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(marker), true);
  } finally { fixture.cleanup(); }
});
