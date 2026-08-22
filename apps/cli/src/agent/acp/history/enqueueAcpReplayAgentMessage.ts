import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';

export async function enqueueAcpReplayAgentMessage(params: Readonly<{
  session: AcpReplaySidechainSessionClient;
  provider: ACPProvider;
  body: ACPMessageData;
  localId: string;
  meta: Record<string, unknown>;
  provenanceSource: 'history' | 'sidechain';
}>): Promise<void> {
  const admission = await params.session.enqueueAgentMessageCommitted(
    params.provider,
    params.body,
    {
      localId: params.localId,
      meta: params.meta,
      provenance: { kind: 'non_dependent', source: params.provenanceSource },
    },
  );
  if (!admission.persisted) {
    throw new Error(`ACP ${params.provenanceSource} replay row was not admitted to durable custody`);
  }
}
