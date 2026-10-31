import { describe, expect, it } from 'vitest';

import { buildCursorSessionControlsProbeResult } from './probe.js';

describe('buildCursorSessionControlsProbeResult', () => {
  it('combines CLI models with trimmed, unique, nonblank ACP controls', () => {
    expect(buildCursorSessionControlsProbeResult({
      modelsOutput: 'composer-2.5-fast - Composer 2.5 Fast (current, default)',
      acpModes: [' agent ', '', 'plan', 'agent', ' ask ', '\t'],
      acpConfigOptions: ['mode', ' model ', 'mode', 'fast', ' '],
    })).toEqual({
      models: [{ id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', current: true, default: true }],
      modes: ['agent', 'plan', 'ask'],
      configOptions: ['mode', 'model', 'fast'],
    });
  });
});
