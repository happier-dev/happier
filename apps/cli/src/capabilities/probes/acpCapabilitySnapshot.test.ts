import { describe, expect, it } from 'vitest';

import { buildAcpCapabilitySnapshot } from './acpCapabilitySnapshot';

describe('buildAcpCapabilitySnapshot', () => {
  it('normalizes full ACP capability payload on success', () => {
    const out = buildAcpCapabilitySnapshot({
      ok: true,
      checkedAt: 123,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          setModel: true,
        },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: false,
        },
      },
    } as any);

    expect(out).toEqual({
      ok: true,
      checkedAt: 123,
      loadSession: true,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          setModel: true,
        },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: false,
        },
      },
    });
  });

  it('returns normalized error payload on failure', () => {
    const out = buildAcpCapabilitySnapshot({
      ok: false,
      checkedAt: 456,
      error: { message: 'boom' },
    } as any);

    expect(out.ok).toBe(false);
    expect(out.checkedAt).toBe(456);
    expect((out as any).error?.message).toContain('boom');
  });
});
