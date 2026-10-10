import { describe, expect, it, vi } from 'vitest';
import { playRealtimeCatalogPreview, readRealtimeCatalogPreview, stopRealtimeCatalogPreview, type VoiceCatalogPreviewSynthesizer } from './catalogPreview';

describe('the shared catalog preview owner', () => {
  it('previews an installed voice without requiring a remote preview URL', async () => {
    // Synthesis/playback is an external engine boundary; selection and preview custody remain real.
    const synthesize = vi.fn(async () => {});
    const result = await playRealtimeCatalogPreview({ providerId: 'happier.voice.builtin/local-neural',
      row: { id: 'am_adam', name: 'Adam' }, isCurrent: () => true, synthesize });
    expect(result).toMatchObject({ status: 'completed' });
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ row: { id: 'am_adam', name: 'Adam' } }));
    expect(readRealtimeCatalogPreview()).toBeNull();
  });

  it('interrupts pending synthesis and cannot publish its late completion', async () => {
    let release!: () => void;
    const engine = new Promise<void>(resolve => { release = resolve; });
    const stopped = vi.fn();
    const synthesize: VoiceCatalogPreviewSynthesizer = async ({ signal, registerPlaybackStopper }) => {
      const unregister = registerPlaybackStopper(stopped);
      try { await engine; expect(signal.aborted).toBe(true); } finally { unregister(); }
    };
    const providerId = 'happier.voice.builtin/local-neural';
    const pending = playRealtimeCatalogPreview({ providerId, row: { id: 'am_adam', name: 'Adam' },
      isCurrent: () => true, synthesize });
    expect(readRealtimeCatalogPreview()).toEqual({ providerId, voiceId: 'am_adam' });
    expect(stopRealtimeCatalogPreview(providerId)).toBe(true);
    release();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(stopped).toHaveBeenCalled();
    expect(readRealtimeCatalogPreview()).toBeNull();
  });
});
