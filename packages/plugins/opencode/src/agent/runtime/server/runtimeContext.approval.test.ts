import { describe, expect, it, vi } from 'vitest';
import type {
  InteractionTransientApprovalAuthorRequestV1,
  InteractionTransientApprovalResultV1,
} from '@happier-dev/plugin-sdk/interactions';

import { requestOpenCodeApprovalWithSignal } from './runtimeContext.js';

const REQUEST = {
  kind: 'approval',
  title: 'Allow Bash?',
  subject: {
    kind: 'tool',
    name: 'bash',
    input: { command: 'git status' },
  },
  allowSessionPersistence: true,
} as const satisfies InteractionTransientApprovalAuthorRequestV1;

describe('requestOpenCodeApprovalWithSignal', () => {
  it('settles cancelled when turn retirement aborts before a stale approval result', async () => {
    let settle!: (result: InteractionTransientApprovalResultV1) => void;
    const requestApproval = vi.fn(() => new Promise<InteractionTransientApprovalResultV1>((resolve) => {
      settle = resolve;
    }));
    const controller = new AbortController();

    const result = requestOpenCodeApprovalWithSignal({
      request: REQUEST,
      signal: controller.signal,
      requestApproval,
    });
    controller.abort(new Error('provider turn retired'));

    await expect(result).resolves.toEqual({
      requestId: expect.any(String),
      kind: 'approval',
      status: 'requesterAborted',
    });

    settle({ requestId: 'approval-late', kind: 'approval', status: 'approved', persistence: 'session' });
    await Promise.resolve();
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});
