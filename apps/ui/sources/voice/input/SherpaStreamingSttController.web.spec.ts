import { describe, expect, it } from 'vitest';

import { createSherpaStreamingSttController } from './SherpaStreamingSttController.web';

describe('SherpaStreamingSttController (web stub)', () => {
  it('surfaces local_neural STT as unavailable', async () => {
    const patches: any[] = [];
    const controller = createSherpaStreamingSttController({
      setState: (patch) => patches.push(patch),
      getSettings: () => ({}),
    });

    await controller.start('s1');
    expect(patches[patches.length - 1]).toEqual({
      status: 'idle',
      sessionId: null,
      error: 'local_neural_stt_unavailable',
    });

    await expect(controller.stop('s1')).resolves.toBe('');
  });
});

