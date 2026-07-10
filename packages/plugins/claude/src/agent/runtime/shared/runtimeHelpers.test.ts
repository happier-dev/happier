import { describe, expect, it } from 'vitest';

import {
  readClaudeRuntimeConfigEffortUpdate,
  readClaudeRuntimeConfigUltracodeUpdate,
  readClaudeRuntimeDirectory,
  readClaudeRuntimeString,
} from './runtimeHelpers.js';

describe('Claude shared runtime helpers', () => {
  it('distinguishes absent runtime config options from explicit effort clears', () => {
    expect(readClaudeRuntimeConfigEffortUpdate({})).toBeUndefined();
    expect(readClaudeRuntimeConfigEffortUpdate({ configOption: { id: 'reasoning_effort', value: '' } })).toBeNull();
    expect(readClaudeRuntimeConfigEffortUpdate({ configOption: { id: 'effort', value: 'xhigh' } })).toBe('xhigh');
    expect(readClaudeRuntimeConfigUltracodeUpdate({})).toBeUndefined();
    expect(readClaudeRuntimeConfigUltracodeUpdate({ configOption: { id: 'ultracode', value: 'false' } })).toBe(false);
  });

  it('normalizes string and directory inputs for both Claude runtime families', () => {
    expect(readClaudeRuntimeString('  value  ')).toBe('value');
    expect(readClaudeRuntimeString('   ')).toBeNull();
    expect(readClaudeRuntimeDirectory({ cwd: ' /repo ', directory: '/fallback' })).toBe('/repo');
  });
}
);
