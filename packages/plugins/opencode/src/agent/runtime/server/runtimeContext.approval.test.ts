import { describe, expect, it, vi } from 'vitest';
import type {
  PluginUiApprovalRequest,
  PluginUiApprovalResult,
} from '@happier-dev/plugin-sdk/runtime';

import { requestOpenCodeApprovalWithSignal } from './runtimeContext.js';

const REQUEST = {
  title: 'Allow Bash?',
  subject: {
    kind: 'tool',
    name: 'bash',
    input: { command: 'git status' },
  },
  allowSessionPersistence: true,
} as const satisfies PluginUiApprovalRequest;

describe('requestOpenCodeApprovalWithSignal', () => {
  it('settles cancelled when turn retirement aborts before a stale approval result', async () => {
    let settle!: (result: PluginUiApprovalResult) => void;
    const requestApproval = vi.fn(() => new Promise<PluginUiApprovalResult>((resolve) => {
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
      status: 'cancelled',
      diagnostic: {
        code: 'opencode_approval_cancelled',
        severity: 'warning',
        message: 'OpenCode approval was cancelled because its turn no longer owns the request.',
      },
    });

    settle({ status: 'approved', persistence: 'session' });
    await Promise.resolve();
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});
