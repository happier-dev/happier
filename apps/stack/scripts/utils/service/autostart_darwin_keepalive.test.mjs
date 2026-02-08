import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchdPlistXml } from './autostart_darwin.mjs';

test('buildLaunchdPlistXml uses KeepAlive SuccessfulExit=false (avoid launchd restart loops on clean exits)', () => {
  const xml = buildLaunchdPlistXml({
    label: 'dev.happier.stack',
    programArgs: ['/bin/echo', 'start'],
    env: { HAPPIER_STACK_ENV_FILE: '/tmp/env' },
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/err.log',
    workingDirectory: '/tmp',
  });

  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>/m);
  assert.match(xml, /<key>SuccessfulExit<\/key>\s*<false\/>/m);
});

