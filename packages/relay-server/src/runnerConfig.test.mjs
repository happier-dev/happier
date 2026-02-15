import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRunnerInvocation } from './runnerConfig.mjs';

test('parseRunnerInvocation defaults to stable channel and installs ui web bundle', () => {
  const parsed = parseRunnerInvocation([]);
  assert.equal(parsed.channel, 'stable');
  assert.equal(parsed.serverTag, 'server-stable');
  assert.equal(parsed.uiWebTag, 'ui-web-stable');
  assert.equal(parsed.withUiWeb, true);
});

test('parseRunnerInvocation resolves preview tags from channel', () => {
  const parsed = parseRunnerInvocation(['--channel', 'preview']);
  assert.equal(parsed.channel, 'preview');
  assert.equal(parsed.serverTag, 'server-preview');
  assert.equal(parsed.uiWebTag, 'ui-web-preview');
});

test('parseRunnerInvocation honors explicit tag overrides', () => {
  const parsed = parseRunnerInvocation(['--tag', 'server-preview', '--ui-tag', 'ui-web-preview']);
  assert.equal(parsed.serverTag, 'server-preview');
  assert.equal(parsed.uiWebTag, 'ui-web-preview');
});

test('parseRunnerInvocation supports --without-ui', () => {
  const parsed = parseRunnerInvocation(['--without-ui']);
  assert.equal(parsed.withUiWeb, false);
});

