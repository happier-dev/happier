import { describe, expect, it, vi } from 'vitest';

import { createSherpaStreamingSttController } from './SherpaStreamingSttController.web';

describe('SherpaStreamingSttController (web stub)', () => {
  it('surfaces local_neural STT as unavailable', async () => {
    const onCaptureError = vi.fn();
    const controller = createSherpaStreamingSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError,
      getSettings: () => ({}),
    });

    await controller.start('s1');
    expect(onCaptureError).toHaveBeenCalledWith({
      controlSessionId: 's1',
      reason: 'local_neural_stt_unavailable',
    });

    await expect(controller.stop('s1')).resolves.toBe('');
  });
});
