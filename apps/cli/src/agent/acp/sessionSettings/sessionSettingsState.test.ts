import { describe, expect, it } from 'vitest';

import { readSessionModelStateFromSessionResponse } from './sessionSettingsState';

describe('readSessionModelStateFromSessionResponse', () => {
  it('rejects provider model state whose current model is not advertised', () => {
    expect(readSessionModelStateFromSessionResponse({
      models: {
        currentModelId: 'missing-current',
        availableModels: [
          { id: 'advertised-model', name: 'Advertised model' },
        ],
      },
    })).toBeNull();
  });
});
