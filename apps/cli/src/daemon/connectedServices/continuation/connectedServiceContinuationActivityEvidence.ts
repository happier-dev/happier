import {
  detectCommittedProviderActivityAfterLatestUserPrompt,
  type CommittedProviderActivityAfterUserPromptEvidence,
} from '@/api/session/transcriptQueries';
import type { Credentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export type ConnectedServiceContinuationProviderActivityEvidence =
  CommittedProviderActivityAfterUserPromptEvidence['status'];

export type ConnectedServiceOriginalUserMessageRetrySafety =
  | 'allowed'
  | 'blocked_provider_activity'
  | 'unknown';

export function resolveOriginalUserMessageRetrySafetyFromProviderActivityEvidence(
  evidence: ConnectedServiceContinuationProviderActivityEvidence,
): ConnectedServiceOriginalUserMessageRetrySafety {
  if (evidence === 'no_activity_found') return 'allowed';
  if (evidence === 'activity_found') return 'blocked_provider_activity';
  return 'unknown';
}

export async function resolveConnectedServiceContinuationProviderActivityEvidence(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
  failureAtMs: number;
}>): Promise<ConnectedServiceContinuationProviderActivityEvidence> {
  const transport = await resolveSessionTransportContext({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
  });
  if (!transport.ok) return 'unknown';

  const evidence = await detectCommittedProviderActivityAfterLatestUserPrompt({
    token: input.credentials.token,
    sessionId: transport.sessionId,
    encryptionKey: transport.ctx.encryptionKey,
    encryptionVariant: transport.ctx.encryptionVariant,
    failureAtMs: input.failureAtMs,
  });
  return evidence.status;
}
