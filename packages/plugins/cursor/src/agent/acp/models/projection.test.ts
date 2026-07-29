import { describe, expect, it } from 'vitest';

import { projectCursorRuntimeModels } from './projection.js';

describe('projectCursorRuntimeModels', () => {
  it('dedupes proprietary models and preserves exact option ids for the generic host merger', () => {
    expect(projectCursorRuntimeModels([{
        value: 'a',
        name: 'Provider A',
        configOptions: [{
          id: ' effort ', name: 'Provider effort', type: 'select', currentValue: ' high ',
          options: [{ value: ' high ', name: 'High' }],
        }],
      }, { value: 'a', name: 'Duplicate A' }])).toEqual([{
        id: 'a', name: 'Provider A', modelOptions: [
          { id: ' effort ', name: 'Provider effort', type: 'select', currentValue: ' high ', options: [{ value: ' high ', name: 'High' }] },
        ],
      }]);
  });
});
