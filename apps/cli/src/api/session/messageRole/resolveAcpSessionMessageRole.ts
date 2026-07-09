import {
  resolveTranscriptBodySessionMessageRole,
  type SessionMessageRole,
} from '@happier-dev/protocol';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

export function resolveAcpSessionMessageRole(body: ACPMessageData | unknown): SessionMessageRole {
  return resolveTranscriptBodySessionMessageRole({ protocol: 'acp', body });
}
