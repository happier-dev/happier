import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { FX_ACP_STEERING } from './steering.js';

// FX 0.0.14, 1a070af32cdfaf8cd0da6de3dc7f053302828b17, captured
// 2026-10-27 in .project/tmp/vercel-meeting/E-fx-live-probe.md §3.
describe('FX ACP in-flight delivery codec', () => {
  it('requires the exact advertised steering capability', () => {
    expect(FX_ACP_STEERING.isSupported?.({ _meta: { fx: { steering: true } } })).toBe(true);
    for (const capabilities of [null, {}, { _meta: { fx: { steering: false } } }, { _meta: { fx: { steering: 'true' } } }]) {
      expect(FX_ACP_STEERING.isSupported?.(capabilities)).toBe(false);
    }
  });

  const project = (content: readonly JsonValue[]) => FX_ACP_STEERING.buildParams({
    providerSessionId: 'fx-session', inputIds: ['host-input'], input: { text: 'steer' }, content,
  });

  it('opts a concurrent prompt into native steering without inventing a host turn', () => {
    expect(project([{ type: 'text', text: 'Instead reply steered.' }])).toEqual({
      sessionId: 'fx-session', prompt: [{ type: 'text', text: 'Instead reply steered.' }],
      _meta: { fx: { steer: true } },
    });
  });

  it('enforces the native text-only 64 KiB boundary in UTF-8, including joined blocks', () => {
    expect(project([{ type: 'text', text: 'é'.repeat(32_768) }])).not.toBeNull();
    expect(project([{ type: 'text', text: 'é'.repeat(32_768) + 'a' }])).toBeNull();
    expect(project([{ type: 'text', text: 'a'.repeat(65_535) }, { type: 'text', text: 'b' }])).toBeNull();
    expect(project([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])).toBeNull();
    expect(project([{ type: 'text', text: '' }])).toBeNull();
  });

  it('distinguishes absorbed, explicitly dropped, and unknown custody', () => {
    const absorbed = { stopReason: 'end_turn', _meta: { fx: { steering: 'absorbed' } } };
    const dropped = { stopReason: 'cancelled', _meta: { fx: { steering: 'dropped' } } };
    expect(FX_ACP_STEERING.isAccepted(absorbed)).toBe(true);
    expect(FX_ACP_STEERING.isRejected?.(dropped)).toBe(true);
    expect(FX_ACP_STEERING.isAccepted(dropped)).toBe(false);
    expect(FX_ACP_STEERING.isRejected?.(absorbed)).toBe(false);
    for (const response of [null, {}, { stopReason: 'end_turn' }, { _meta: { fx: { steering: true } } }]) {
      expect(FX_ACP_STEERING.isAccepted(response)).toBe(false);
      expect(FX_ACP_STEERING.isRejected?.(response)).toBe(false);
    }
  });
});
