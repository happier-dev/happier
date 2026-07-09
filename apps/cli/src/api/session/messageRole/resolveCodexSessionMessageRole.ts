import {
  resolveTranscriptBodySessionMessageRole,
  type SessionMessageRole,
} from '@happier-dev/protocol';

export function resolveCodexSessionMessageRole(body: unknown): SessionMessageRole {
  return resolveTranscriptBodySessionMessageRole({ protocol: 'codex', body });
}
