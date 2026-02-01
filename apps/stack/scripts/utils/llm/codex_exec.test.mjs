import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexExecArgs, buildCodexExecScript } from './codex_exec.mjs';

test('buildCodexExecArgs builds stdin-prompt args for each permission mode', () => {
  const cd = '/tmp/repo';

  const safe = buildCodexExecArgs({ cd, permissionMode: 'safe' });
  assert.deepEqual(safe, ['exec', '--cd', cd, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-']);

  const full = buildCodexExecArgs({ cd, permissionMode: 'full-auto' });
  assert.deepEqual(full, ['exec', '--cd', cd, '--full-auto', '-']);

  const yolo = buildCodexExecArgs({ cd, permissionMode: 'yolo' });
  assert.deepEqual(yolo, ['exec', '--cd', cd, '--dangerously-bypass-approvals-and-sandbox', '-']);
});

test('buildCodexExecScript embeds prompt via heredoc', () => {
  const script = buildCodexExecScript({ cd: '/tmp/repo', permissionMode: 'full-auto', promptText: 'hello\nworld\n' });
  assert.ok(script.includes('cat <<'));
  assert.ok(script.includes('hello'));
  assert.ok(script.includes('world'));
  assert.ok(script.includes('codex'));
  assert.ok(script.includes('exec'));
});

