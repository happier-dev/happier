import { describe, expect, it } from 'vitest';

import { buildCursorSessionControlsProbeResult } from './probe.js';

describe('buildCursorSessionControlsProbeResult', () => {
  it('combines CLI model rows with ACP modes and config options for the canonical controls layout', () => {
    expect(buildCursorSessionControlsProbeResult({
      modelsOutput: 'composer-2.5-fast - Composer 2.5 Fast (current, default)',
      acpModes: ['agent', 'plan', 'ask'],
      acpConfigOptions: ['mode', 'model', 'fast'],
    })).toEqual({
      models: [{ id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', current: true, default: true }],
      modes: ['agent', 'plan', 'ask'],
      configOptions: ['mode', 'model', 'fast'],
    });
  });
});
