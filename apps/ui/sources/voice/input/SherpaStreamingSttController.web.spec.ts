import { describe, expect, it, vi } from 'vitest';

import { createSherpaStreamingSttController } from './SherpaStreamingSttController.web';
import type { SttSink } from './sttController';

function createSink(): SttSink & { onError: ReturnType<typeof vi.fn> } {
  return {
    onAudioStarted: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEndpoint: vi.fn(),
    onError: vi.fn(),
  };
}

describe('SherpaStreamingSttController (web stub)', () => {
  it('surfaces local_neural STT as unavailable via a typed sink error', async () => {
    const sink = createSink();
    const controller = createSherpaStreamingSttController({ getSettings: () => ({}) });

    await controller.start({ micSession: null as never, sink });
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'local_neural_stt_unavailable',
    }));

    await expect(controller.stop()).resolves.toEqual({ finalText: '' });
  });
});
