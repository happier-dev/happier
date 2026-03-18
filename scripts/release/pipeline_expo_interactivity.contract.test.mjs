import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExpoInteractivity } from '../pipeline/expo/resolve-expo-interactivity.mjs';

test('expo interactivity defaults to interactive on a local TTY', () => {
  const resolved = resolveExpoInteractivity({
    env: { EXPO_TOKEN: 'expo-token' },
    stdinIsTty: true,
    stdoutIsTty: true,
  });

  assert.equal(resolved.isCi, false);
  assert.equal(resolved.hasInteractiveTty, true);
  assert.equal(resolved.nonInteractive, false);
});

test('expo interactivity defaults to non-interactive without a TTY', () => {
  const resolved = resolveExpoInteractivity({
    env: { EXPO_TOKEN: 'expo-token' },
    stdinIsTty: false,
    stdoutIsTty: false,
  });

  assert.equal(resolved.isCi, false);
  assert.equal(resolved.hasInteractiveTty, false);
  assert.equal(resolved.nonInteractive, true);
});

test('expo interactivity allows explicit local override to interactive', () => {
  const resolved = resolveExpoInteractivity({
    env: { EXPO_TOKEN: 'expo-token', PIPELINE_INTERACTIVE: '1' },
    interactiveOverride: 'true',
    stdinIsTty: false,
    stdoutIsTty: false,
  });

  assert.equal(resolved.nonInteractive, false);
});

test('expo interactivity allows explicit local override to non-interactive', () => {
  const resolved = resolveExpoInteractivity({
    env: { EXPO_TOKEN: 'expo-token', PIPELINE_INTERACTIVE: '1' },
    interactiveOverride: 'false',
    stdinIsTty: true,
    stdoutIsTty: true,
  });

  assert.equal(resolved.nonInteractive, true);
});

test('expo interactivity stays non-interactive in CI', () => {
  const resolved = resolveExpoInteractivity({
    env: { EXPO_TOKEN: 'expo-token', CI: 'true', PIPELINE_INTERACTIVE: '1' },
    stdinIsTty: true,
    stdoutIsTty: true,
  });

  assert.equal(resolved.isCi, true);
  assert.equal(resolved.nonInteractive, true);
});
