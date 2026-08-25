import { beforeEach, describe, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  getModelPackInstallSummary: vi.fn(),
}));

vi.mock('@/voice/modelPacks/installer.native', () => installer);

describe('readVoiceDictationNativeModelReadiness (native)', () => {
  beforeEach(() => {
    installer.getModelPackInstallSummary.mockReset();
  });

  it('uses the installer-owned status for the exact selected pack', async () => {
    installer.getModelPackInstallSummary.mockResolvedValue({
      installed: true,
      packDirUri: 'file:///packs/selected-stt-pack',
      manifest: { packId: 'selected-stt-pack' },
    });
    const { readVoiceDictationNativeModelReadiness } = await import(
      './voiceDictationNativeModelReadiness.native'
    );

    await expect(readVoiceDictationNativeModelReadiness('selected-stt-pack')).resolves.toBe('ready');
    expect(installer.getModelPackInstallSummary).toHaveBeenCalledWith({
      packId: 'selected-stt-pack',
    });
  });

  it('reports a selected but uninstalled pack as missing and does not invent a default for no selection', async () => {
    installer.getModelPackInstallSummary.mockResolvedValue({
      installed: false,
      packDirUri: 'file:///packs/missing-stt-pack',
      manifest: null,
    });
    const { readVoiceDictationNativeModelReadiness } = await import(
      './voiceDictationNativeModelReadiness.native'
    );

    await expect(readVoiceDictationNativeModelReadiness('missing-stt-pack')).resolves.toBe('missing');
    await expect(readVoiceDictationNativeModelReadiness(null)).resolves.toBe('unknown');
    expect(installer.getModelPackInstallSummary).toHaveBeenCalledTimes(1);
  });
});
