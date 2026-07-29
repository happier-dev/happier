import { describe, expect, it } from 'vitest';

import {
  HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
  clearPendingFirstInputFromEnv,
  createPendingFirstInput,
  readPendingFirstInputFromEnv,
  serializePendingFirstInputForEnv,
} from './pendingFirstInput';

describe('pendingFirstInput', () => {
  it('derives the canonical stable first-turn identity without changing prompt bytes', () => {
    expect(createPendingFirstInput({
      text: '  keep prompt whitespace  ',
      spawnNonce: ' launch-1 ',
    })).toEqual({
      text: '  keep prompt whitespace  ',
      localId: 'spawn-first-turn:launch-1',
    });
  });

  it('rejects blank text and spawn identities instead of manufacturing an empty handoff', () => {
    expect(() => createPendingFirstInput({ text: '   ', spawnNonce: 'launch-1' })).toThrow(
      'Pending first input text must not be blank',
    );
    expect(() => createPendingFirstInput({ text: 'hello', spawnNonce: '   ' })).toThrow(
      'Pending first input spawn nonce must not be blank',
    );
  });

  it('round-trips the one child environment handoff and preserves opaque localId bytes', () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv({
        text: 'line one\nline two\u0000',
        localId: '  opaque local id  ',
      }),
    };

    expect(readPendingFirstInputFromEnv(env)).toEqual({
      text: 'line one\nline two\u0000',
      localId: '  opaque local id  ',
    });
    expect(env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeDefined();

    clearPendingFirstInputFromEnv(env);
    expect(env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeUndefined();
  });
});
