import { beforeEach, describe, expect, it, vi } from 'vitest';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import {
  resetVoiceDiagnosticsSessionPolicyForTests,
  resolveVoiceDiagnosticsCaptureContext,
  resolveVoiceDiagnosticsCaptureContextFromSettings,
  setVoiceDiagnosticsSessionCaptureAllowed,
} from './capturePolicy';

const enabledSettings = {
  voice: voiceSettingsParse({
    diagnostics: {
      v: 1,
      enabled: true,
      consentVersion: 1,
      captureSttInput: true,
      captureTtsOutput: false,
    },
  }),
};

describe('voice diagnostics capture policy', () => {
  beforeEach(resetVoiceDiagnosticsSessionPolicyForTests);

  it('requires global consent, the matching direction, and a non-opted-out session', () => {
    for (const diagnostics of [
      { ...enabledSettings.voice.diagnostics, enabled: false },
      { ...enabledSettings.voice.diagnostics, consentVersion: null },
      { enabled: true, captureSttInput: true },
    ]) {
      expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
        settings: { voice: { ...enabledSettings.voice, diagnostics } },
        sessionId: 'session-1',
        direction: 'stt_input',
        durationMs: 100,
      })).toBeUndefined();
    }
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'stt_input',
      durationMs: 100,
    })).toMatchObject({
      sessionId: 'session-1',
      captureAllowed: true,
      durationMs: 100,
      authorizationId: expect.any(String),
    });
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'tts_output',
      durationMs: null,
    })).toBeUndefined();

    setVoiceDiagnosticsSessionCaptureAllowed('session-1', false);
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'stt_input',
      durationMs: 100,
    })).toBeUndefined();
  });

  it('never writes session opt-outs into account or sync state', () => {
    const previousState = storage.getState();
    storage.setState({ settings: { ...previousState.settings, voice: enabledSettings.voice } });
    const sessionId = '../sensitive/session';
    const capture = (id: string) => resolveVoiceDiagnosticsCaptureContext({
      sessionId: id, direction: 'stt_input', durationMs: null,
    });
    expect(capture(sessionId)).toMatchObject({ sessionId, captureAllowed: true });
    const beforeOptOut = storage.getState();
    const persistence = getPersistenceStorage();
    // Observe the genuine device-storage adapter; do not replace Settings or Sync owners.
    const set = vi.spyOn(persistence, 'set');
    const remove = vi.spyOn(persistence, 'delete');
    const clear = vi.spyOn(persistence, 'clearAll');
    const published = vi.fn();
    const unsubscribe = storage.subscribe(published);
    try {
      setVoiceDiagnosticsSessionCaptureAllowed(sessionId, false);
      expect(capture(sessionId)).toBeUndefined();
      expect(capture('still-authorized')).toMatchObject({ sessionId: 'still-authorized', captureAllowed: true });
      expect(storage.getState()).toBe(beforeOptOut);
      expect(storage.getState().settings.voice.diagnostics.enabled).toBe(true);
      expect(published).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      set.mockRestore();
      remove.mockRestore();
      clear.mockRestore();
      storage.setState(previousState);
    }
  });
});
