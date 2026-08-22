import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('voice surface architecture', () => {
  it('keeps runtime audio-level writers independent from component modules', async () => {
    const source = await readFile('sources/voice/local/localVoiceEngine.ts', 'utf8');
    expect(source).not.toContain('@/components/voice/surface/voiceLevelShared');
  });

  it('does not mirror canonical session mode through a second telemetry store', async () => {
    const source = await readFile('sources/components/voice/surface/useVoiceSurfaceModel.ts', 'utf8');
    expect(source).not.toContain('voiceSurfaceTelemetryStore');
    expect(source).not.toContain('setVoiceSurfaceTelemetry');
  });

  it('keeps one placement-neutral attempt state and command selector for every Voice surface', async () => {
    const [model, actions, horizon] = await Promise.all([
      readFile('sources/components/voice/surface/useVoiceSurfaceModel.ts', 'utf8'),
      readFile('sources/components/voice/surface/createVoiceSurfaceActionHandlers.ts', 'utf8'),
      readFile('sources/components/voice/surface/presentations/VoiceHorizon.tsx', 'utf8'),
    ]);

    expect(model).toContain('useVoiceAttemptControl(idleTarget)');
    expect(model).not.toContain('resolveVoiceSurfaceState({');
    expect(model).not.toContain('snap.canStop');
    expect(model).not.toContain('snap.micMuted');
    expect(actions).not.toContain('voiceSessionManager.stop(');
    expect(actions).not.toContain('voiceSessionManager.setMuted(');
    expect(horizon).toContain('model.attemptControl');
    expect(horizon).not.toContain('lightForTone');
  });
});
