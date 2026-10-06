import { logger } from '@/ui/logger';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { describe, expect, it, vi } from 'vitest';

import { createActionOperationSnapshotPublisher, emitActionOperationSnapshotV1 } from './apiMachine';

describe('Action operation snapshot producer compatibility', () => {
  it('emits exactly the immutable released 0.2.11 envelope once', () => {
    const emit = vi.fn();

    emitActionOperationSnapshotV1({
      socket: { emit },
      machineId: 'machine-1',
      ciphertext: 'sealed-snapshot',
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('action-operation-updated', {
      type: 'action-operation-updated',
      machineId: 'machine-1',
      content: { t: 'encrypted', c: 'sealed-snapshot' },
    });
  });
  it('withholds queued publication after credentials move to another Account and accepts same-Account refresh', async () => {
    const token = (subject: string, refresh: string) => `e30.${Buffer.from(JSON.stringify({ sub: subject, refresh })).toString('base64url')}.signature`;
    const publishCiphertext = vi.fn();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let subject = 'account-a';
    let refresh = 'first';
    const publisher = createActionOperationSnapshotPublisher({
      resolveAccountId: async () => 'account-a',
      readCredentials: async () => ({ token: token(subject, refresh), encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
      publishCiphertext,
    });
    const snapshot: ActionOperationSnapshotV1 = {
      version: 1, operationId: 'operation-a', revision: 1, actionId: 'session.fork', state: 'accepted',
      scope: { accountId: 'account-a', machineId: 'machine-a' }, title: 'Fork', createdAt: 1, cancellation: 'unsupported',
    };
    try {
      const queued = publisher(snapshot);
      subject = 'account-b';
      await queued;
      expect(publishCiphertext).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalled();
      subject = 'account-a'; refresh = 'rotated-token';
      await publisher({ ...snapshot, revision: 2 });
      expect(publishCiphertext).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

});
