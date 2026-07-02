import { describe, expect, it } from 'vitest';

import { OPEN_CODE_ACP_BACKEND_SPEC } from './openCodeAcpBackendSpec.js';
import { normalizeOpenCodeAcpPermissionRulesetMessage } from './permission.js';

describe('OpenCode ACP permission ruleset compatibility', () => {
  it('coerces nested ruleset action aliases to ACP canonical values', () => {
    const normalized = normalizeOpenCodeAcpPermissionRulesetMessage({
      jsonrpc: '2.0',
      method: 'requestPermission',
      params: {
        nested: {
          ruleset: [
            { tool: 'read', action: 'allow' },
            { tool: 'write', action: 'prompt' },
            { tool: 'edit', action: 'ASK_USER' },
            { tool: 'bash', action: 'reject' },
            { tool: 'task', action: 'permit' },
          ],
        },
      },
    });

    expect(normalized).toMatchObject({
      params: {
        nested: {
          ruleset: [
            { action: 'allow' },
            { action: 'ask' },
            { action: 'ask' },
            { action: 'deny' },
            { action: 'allow' },
          ],
        },
      },
    });
  });

  it('coerces missing and non-string ruleset actions to ask', () => {
    const normalized = normalizeOpenCodeAcpPermissionRulesetMessage({
      params: {
        ruleset: [
          { action: true },
          { action: null },
          { tool: 'edit' },
        ],
      },
    });

    expect(normalized).toMatchObject({
      params: {
        ruleset: [
          { action: 'ask' },
          { action: 'ask' },
          { action: 'ask' },
        ],
      },
    });
  });

  it('returns null when a message does not need compatibility changes', () => {
    expect(normalizeOpenCodeAcpPermissionRulesetMessage({
      params: {
        ruleset: [
          { action: 'allow' },
          { action: 'deny' },
          { action: 'ask' },
        ],
      },
    })).toBeNull();

    expect(normalizeOpenCodeAcpPermissionRulesetMessage({
      params: { ruleset: { action: 'ask' } },
    })).toBeNull();
  });

  it('wires the compatibility normalizer through the ACP incoming message hook', async () => {
    const hook = OPEN_CODE_ACP_BACKEND_SPEC.transport.customHandler?.onMessage;
    expect(typeof hook).toBe('function');

    const decision = await hook?.({
      params: {
        ruleset: [{ action: 'approve' }],
      },
    }, { sessionId: 'session-1', phase: 'incoming' });

    expect(decision).toEqual({
      kind: 'replace',
      message: {
        params: {
          ruleset: [{ action: 'allow' }],
        },
      },
    });

    expect(await hook?.({
      params: { ruleset: [{ action: 'approve' }] },
    }, { sessionId: 'session-1', phase: 'outgoing' })).toBe('pass');
  });
});
