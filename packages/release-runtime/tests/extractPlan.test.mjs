import test from 'node:test';
import assert from 'node:assert/strict';

import { planArchiveExtraction } from '../dist/extractPlan.js';

test('planArchiveExtraction selects tar for .tar.gz archives', () => {
  const planned = planArchiveExtraction({
    archiveName: 'happier-server-v1.2.3-linux-x64.tar.gz',
    archivePath: '/tmp/server.tgz',
    destDir: '/tmp/extract',
    os: 'linux',
  });
  assert.equal(planned.requiredCommand, 'tar');
  assert.deepEqual(planned.command, {
    cmd: 'tar',
    args: ['-xzf', '/tmp/server.tgz', '-C', '/tmp/extract'],
  });
});

test('planArchiveExtraction selects powershell Expand-Archive for .zip archives on windows', () => {
  const planned = planArchiveExtraction({
    archiveName: 'happier-server-v1.2.3-windows-x64.zip',
    archivePath: 'C:\\\\Temp\\\\server.zip',
    destDir: 'C:\\\\Temp\\\\extract',
    os: 'windows',
  });
  assert.equal(planned.requiredCommand, 'powershell');
  assert.equal(planned.command.cmd, 'powershell');
  assert.match(planned.command.args.join(' '), /Expand-Archive/i);
});

test('planArchiveExtraction rejects unknown archive extensions', () => {
  assert.throws(() => {
    planArchiveExtraction({
      archiveName: 'happier-server-v1.2.3-linux-x64.rar',
      archivePath: '/tmp/server.rar',
      destDir: '/tmp/extract',
      os: 'linux',
    });
  }, /unsupported/i);
});

