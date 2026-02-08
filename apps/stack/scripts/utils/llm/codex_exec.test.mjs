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

test('buildCodexExecArgs defaults to full-auto when permission mode is blank', () => {
  const args = buildCodexExecArgs({ cd: '/tmp/repo', permissionMode: '   ' });
  assert.deepEqual(args, ['exec', '--cd', '/tmp/repo', '--full-auto', '-']);
});

test('buildCodexExecArgs rejects missing cd and invalid permission modes', () => {
  assert.throws(() => buildCodexExecArgs({ cd: '', permissionMode: 'safe' }), /missing cd/i);
  assert.throws(() => buildCodexExecArgs({ cd: '/tmp/repo', permissionMode: 'unsafe' }), /invalid permission mode/i);
});

test('buildCodexExecScript preserves quoted prompt content in heredoc body', () => {
  const prompt = `Line "one"\nLine 'two'\n$HOME`;
  const script = buildCodexExecScript({ cd: '/tmp/repo', permissionMode: 'safe', promptText: prompt });
  assert.match(script, /cat <<'HS_CODEX_PROMPT_/);
  assert.match(script, /Line "one"/);
  assert.match(script, /Line 'two'/);
  assert.match(script, /\$HOME/);
  assert.match(script, /"--ask-for-approval" "on-request"/);
});
