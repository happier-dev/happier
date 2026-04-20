import { describe, expect, it } from 'vitest';

import { publishRuntimeCapabilities } from './runtimeCapabilitiesPublication.js';

describe('publishRuntimeCapabilities', () => {
  it('preserves explicit runtime capability fields and fills executionRun with a null default', () => {
    expect(publishRuntimeCapabilities({
      localControl: { supported: true },
      sessionStorage: { direct: true, persisted: false },
      executionRun: { supported: true },
    })).toEqual({
      localControl: { supported: true },
      sessionStorage: { direct: true, persisted: false },
      executionRun: { supported: true },
    });

    expect(publishRuntimeCapabilities({
      tools: { delivery: 'native_mcp', support: 'supported' },
    })).toEqual({
      tools: { delivery: 'native_mcp', support: 'supported' },
      executionRun: null,
    });
  });
});
