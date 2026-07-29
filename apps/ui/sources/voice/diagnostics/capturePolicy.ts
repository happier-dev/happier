import type { VoiceSpeechDiagnosticsCaptureContextV1 } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { randomUUID } from '@/platform/randomUUID';

type DiagnosticDirection = 'stt_input' | 'tts_output';

// Per-session opt-outs are intentionally process-local and never enter session
// metadata, account settings, sync, analytics, or provider context.
const disabledSessionIds = new Set<string>();
const authorizationIdsBySession = new Map<string, string>();

export function resolveVoiceDiagnosticsCaptureAuthorizationId(sessionId: string): string {
  const existing = authorizationIdsBySession.get(sessionId);
  if (existing) return existing;
  const created = randomUUID();
  authorizationIdsBySession.set(sessionId, created);
  return created;
}

export function setVoiceDiagnosticsSessionCaptureAllowed(sessionId: string, allowed: boolean): void {
  if (!sessionId) return;
  if (allowed) disabledSessionIds.delete(sessionId);
  else disabledSessionIds.add(sessionId);
}

export function isVoiceDiagnosticsSessionCaptureAllowed(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && !disabledSessionIds.has(sessionId!);
}

export function resolveVoiceDiagnosticsCaptureContextFromSettings(input: Readonly<{
  settings: unknown;
  sessionId: string | null | undefined;
  direction: DiagnosticDirection;
  durationMs: number | null;
}>): VoiceSpeechDiagnosticsCaptureContextV1 | undefined {
  const sessionId = input.sessionId;
  if (!isVoiceDiagnosticsSessionCaptureAllowed(sessionId) || !sessionId) return undefined;
  const rawSettings = input.settings && typeof input.settings === 'object'
    ? (input.settings as { voice?: unknown }).voice
    : undefined;
  const diagnostics = voiceSettingsParse(rawSettings).diagnostics;
  if (!diagnostics.enabled || diagnostics.consentVersion !== 1) return undefined;
  if (input.direction === 'stt_input' && !diagnostics.captureSttInput) return undefined;
  if (input.direction === 'tts_output' && !diagnostics.captureTtsOutput) return undefined;
  return {
    sessionId,
    captureAllowed: true,
    durationMs: input.durationMs,
    authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId(sessionId),
  };
}

export function resolveVoiceDiagnosticsCaptureContext(input: Readonly<{
  sessionId: string | null | undefined;
  direction: DiagnosticDirection;
  durationMs: number | null;
}>): VoiceSpeechDiagnosticsCaptureContextV1 | undefined {
  return resolveVoiceDiagnosticsCaptureContextFromSettings({
    ...input,
    settings: storage.getState().settings,
  });
}

export function resetVoiceDiagnosticsSessionPolicyForTests(): void {
  disabledSessionIds.clear();
  authorizationIdsBySession.clear();
}
