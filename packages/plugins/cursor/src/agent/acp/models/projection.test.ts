import { describe, expect, it } from 'vitest';

import { projectCursorRuntimeModels } from './projection.js';

describe('projectCursorRuntimeModels', () => {
  it('dedupes proprietary models and canonicalizes known Cursor option aliases for the generic host merger', () => {
    expect(projectCursorRuntimeModels([{
        value: 'a',
        name: 'Provider A',
        configOptions: [
          {
            id: ' effort ', name: 'Provider effort', type: 'select', currentValue: ' high ',
            options: [{ value: ' high ', name: 'High' }],
          },
          {
            id: 'reasoning_effort', name: 'Duplicate effort', type: 'select', currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
          {
            id: ' provider-specific ', name: 'Provider specific', type: 'select', currentValue: 'on',
            options: [{ value: 'on', name: 'On' }],
          },
        ],
      }, { value: 'a', name: 'Duplicate A' }])).toEqual([{
        id: 'a', name: 'Provider A', modelOptions: [
          { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: ' high ', options: [{ value: ' high ', name: 'High' }] },
          { id: ' provider-specific ', name: 'Provider specific', type: 'select', currentValue: 'on', options: [{ value: 'on', name: 'On' }] },
        ],
      }]);
  });
});
