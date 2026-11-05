import { describe, expect, it } from 'vitest';
import { buildModelCatalogRows } from '@/voice/settings/panels/modelCatalog/buildModelCatalogRows';

describe('formatModelPackDisplayName', () => {
  it('shows human pack names while preserving the machine-readable model identities', () => {
    const rows = buildModelCatalogRows({ statuses: [], selectedSttPackId: null, selectedTtsPackId: null });
    expect(rows.stt.find(row => row.packId === 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'))
      .toMatchObject({ displayName: 'Parakeet v3 (0.6B, int8)', model: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8' });
    expect(rows.tts.find(row => row.packId === 'kokoro-82m-v1.0-onnx-q8-wasm'))
      .toMatchObject({ displayName: 'Kokoro v1.0 (q8)' });
  });
});
