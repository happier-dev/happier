import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import type { SessionMessageRole } from '@happier-dev/protocol';

export function resolveCodexSessionMessageRole(body: unknown): SessionMessageRole {
  return resolveTranscriptBodySessionMessageRole({ protocol: 'codex', body });
}
