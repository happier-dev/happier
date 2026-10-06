import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import type { SessionMessageRole } from '@happier-dev/protocol';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

export function resolveAcpSessionMessageRole(body: ACPMessageData | unknown): SessionMessageRole {
  return resolveTranscriptBodySessionMessageRole({ protocol: 'acp', body });
}
