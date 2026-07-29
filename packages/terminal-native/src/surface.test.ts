import { describe, expect, it } from 'vitest';

import {
  normalizeTerminalNativeSurfaceMetrics,
  normalizeTerminalNativeWriteResult,
} from './surface';

describe('terminal native surface contracts', () => {
  it('normalizes accepted native write acknowledgements', () => {
    expect(normalizeTerminalNativeWriteResult({
      accepted: true,
      byteOffset: 2048,
    }, 1024)).toEqual({
      accepted: true,
      byteOffset: 2048,
    });
  });

  it('rejects malformed or regressing native write acknowledgements', () => {
    expect(normalizeTerminalNativeWriteResult({
      accepted: true,
      byteOffset: 1023,
    }, 1024)).toEqual({
      accepted: false,
      reason: 'invalid-ack',
      detail: 'Native terminal write acknowledgement was missing or regressed.',
    });
  });

  it('normalizes structured native write rejection reasons', () => {
    expect(normalizeTerminalNativeWriteResult({
      accepted: false,
      reason: 'queue-full',
      detail: 'renderer backpressure',
    }, 1024)).toEqual({
      accepted: false,
      reason: 'queue-full',
      detail: 'renderer backpressure',
    });
  });

  it('normalizes positive terminal surface metrics', () => {
    expect(normalizeTerminalNativeSurfaceMetrics({ cols: 120, rows: 40 })).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(normalizeTerminalNativeSurfaceMetrics({ cols: 0, rows: 40 })).toBeNull();
    expect(normalizeTerminalNativeSurfaceMetrics({ cols: 120, rows: 0 })).toBeNull();
  });
});
