import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
  createPendingFirstInput,
  createPendingFirstInputCommitter,
  readPendingFirstInputFromEnv,
  serializePendingFirstInputForEnv,
} from './pendingFirstInput';

describe('pending first input handoff', () => {
  it('derives one stable local id from the spawn nonce while preserving exact text bytes', () => {
    const first = createPendingFirstInput({ text: '  exact input  ', spawnNonce: 'nonce-1' });
    const retry = createPendingFirstInput({ text: '  exact input  ', spawnNonce: ' nonce-1 ' });
    const other = createPendingFirstInput({ text: '  exact input  ', spawnNonce: 'nonce-2' });

    expect(first.text).toBe('  exact input  ');
    expect(retry.localId).toBe(first.localId);
    expect(other.localId).not.toBe(first.localId);
  });

  it('round-trips exact localId bytes while rejecting blank identities', () => {
    const input = {
      text: 'send me',
      localId: ' spawn-first:opaque ',
      meta: { model: 'opus' },
    };
    const env = {
      [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv(input),
    };

    expect(readPendingFirstInputFromEnv(env)).toEqual(input);
    expect(() => serializePendingFirstInputForEnv({ text: 'send me', localId: '   ' })).toThrow(
      'Pending first input local id must not be blank',
    );
  });
  it('coalesces concurrent readiness callbacks into one durable first-input commit', async () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv({
        text: 'only once',
        localId: 'spawn-first:concurrent',
      }),
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const enqueueSessionUserMessage = vi.fn(async () => blocked);
    const committer = createPendingFirstInputCommitter(env);

    const first = committer.commit({ enqueueSessionUserMessage });
    const duplicate = committer.commit({ enqueueSessionUserMessage });
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
    expect(committer.hasPendingInput).toBe(true);

    release();
    await Promise.all([first, duplicate]);
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
    expect(committer.hasPendingInput).toBe(false);
    expect(env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeUndefined();
  });
});
