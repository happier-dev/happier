import { isVoiceQaDebugRuntime } from '@/voice/qa/voiceQaDebugRuntime';

export type DaemonSpeechStreamQaRouteRequirement = 'server_relay';

type InstalledRequirement = Readonly<{
  routeKind: DaemonSpeechStreamQaRouteRequirement;
  token: symbol;
}>;

const installedRequirements = new Map<string, InstalledRequirement>();

function normalizeSessionId(sessionId: string | null | undefined): string | null {
  const normalized = sessionId?.trim() ?? '';
  return normalized || null;
}

export function installDaemonSpeechStreamQaRouteRequirement(input: Readonly<{
  sessionId: string;
  routeKind: DaemonSpeechStreamQaRouteRequirement;
}>): () => void {
  const sessionId = normalizeSessionId(input.sessionId);
  if (!sessionId || !isVoiceQaDebugRuntime()) return () => {};

  const installed = {
    routeKind: input.routeKind,
    token: Symbol('daemon-speech-stream-qa-route-requirement'),
  } satisfies InstalledRequirement;
  installedRequirements.set(sessionId, installed);

  return () => {
    if (installedRequirements.get(sessionId)?.token === installed.token) {
      installedRequirements.delete(sessionId);
    }
  };
}

export function readDaemonSpeechStreamQaRouteRequirement(
  sessionId: string | null | undefined,
): DaemonSpeechStreamQaRouteRequirement | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId || !isVoiceQaDebugRuntime()) return null;
  return installedRequirements.get(normalizedSessionId)?.routeKind ?? null;
}
