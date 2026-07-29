import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('voice surface architecture', () => {
  it('keeps runtime audio-level writers independent from component modules', async () => {
    const source = await readFile('sources/voice/local/localVoiceEngine.ts', 'utf8');
    expect(source).not.toContain('@/components/voice/surface/voiceLevelShared');
  });

  it('keeps domain-state projection out of the motion component', async () => {
    const source = await readFile('sources/components/voice/surface/VoiceSurfaceMotionFrame.tsx', 'utf8');
    expect(source).not.toContain('resolveVoiceMotionState');
    expect(source).toContain('surfaceState: VoiceSurfaceState');
  });

  it('does not mirror canonical session mode through a second telemetry store', async () => {
    const source = await readFile('sources/components/voice/surface/useVoiceSurfaceModel.ts', 'utf8');
    expect(source).not.toContain('voiceSurfaceTelemetryStore');
    expect(source).not.toContain('setVoiceSurfaceTelemetry');
  });
});
