import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
  clearPendingFirstInputFromEnv,
  createPendingFirstInput,
  createPendingFirstInputCommitter,
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

  it('retains custody after a failed commit and clears the handoff only after a retry succeeds', async () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv({
        text: 'retry this first turn',
        localId: 'spawn-first-turn:retry-safe',
      }),
    };
    const enqueueSessionUserMessage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary enqueue failure'))
      .mockResolvedValueOnce(undefined);
    const committer = createPendingFirstInputCommitter({ env });

    await expect(committer.commit({ enqueueSessionUserMessage })).rejects.toThrow(
      'temporary enqueue failure',
    );
    expect(env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeDefined();

    await committer.commit({ enqueueSessionUserMessage });
    await committer.commit({ enqueueSessionUserMessage });

    expect(enqueueSessionUserMessage).toHaveBeenCalledTimes(2);
    expect(enqueueSessionUserMessage).toHaveBeenLastCalledWith({
      text: 'retry this first turn',
      localId: 'spawn-first-turn:retry-safe',
      meta: { source: 'ui', sentFrom: 'cli' },
      inputAdmission: {
        provenance: { v: 1, kind: 'host', producer: 'agentRuntimeFirstInput' },
        request: {
          v: 1,
          producer: 'agentRuntimeFirstInput',
          caller: { kind: 'host' },
          permission: {},
        },
      },
    });
    expect(env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeUndefined();
  });
});
