import { getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';

import { getProviderAttachOps } from '@/backends/catalog';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { buildCliSessionRowModel } from '@/sessionControl/buildCliSessionRowModel';
import { evaluateCliSessionAttachEligibility } from '@/sessionControl/evaluateCliSessionAttachEligibility';
import type { RawSessionListRow } from '@/sessionControl/sessionsHttp';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { SessionActionSelectorRow } from '@/ui/ink/SessionActionSelector';

type FetchSessionsPageFn = (params: {
  token: string;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
  archivedOnly?: boolean;
}) => Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

type ReadTerminalAttachmentInfoFn = (params: {
  happyHomeDir: string;
  sessionId: string;
}) => Promise<TerminalAttachmentInfo | null>;

export type AttachSelectionModel = Readonly<{
  rows: SessionActionSelectorRow[];
  probeSessionIdFn: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>;

export async function buildAttachSelectionModel(params: Readonly<{
  credentials: Credentials;
  currentMachineId: string;
  fetchSessionsPageFn: FetchSessionsPageFn;
  readTerminalAttachmentInfoFn: ReadTerminalAttachmentInfoFn;
}>): Promise<AttachSelectionModel> {
  const page = await params.fetchSessionsPageFn({
    token: params.credentials.token,
    limit: 200,
    activeOnly: true,
  });
  const rows: SessionActionSelectorRow[] = [];
  const remoteProviderMetadataBySessionId = new Map<string, { agentId: AgentId; metadata: Record<string, unknown> }>();
  for (const rawSession of page.sessions) {
    const rowModel = buildCliSessionRowModel({ credentials: params.credentials, rawSession });
    if (rowModel.isSystem) continue;

    const localInfo = await params.readTerminalAttachmentInfoFn({
      happyHomeDir: configuration.happyHomeDir,
      sessionId: rawSession.id,
    });
    const eligibility = evaluateCliSessionAttachEligibility({
      credentials: params.credentials,
      rawSession,
      currentMachineId: params.currentMachineId,
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });
    const resolvedEligibility = await eligibility;

    const metadataMachineId =
      resolvedEligibility.metadata && typeof resolvedEligibility.metadata.machineId === 'string' && resolvedEligibility.metadata.machineId.trim().length > 0
        ? resolvedEligibility.metadata.machineId.trim()
        : null;
    const shouldInclude =
      localInfo !== null
      || metadataMachineId === params.currentMachineId
      || getAgentLocalControlCapability(rowModel.agentId)?.attachStrategy === 'provider_attach';
    if (!shouldInclude) continue;

    rows.push({
      sessionId: rowModel.id,
      agentId: rowModel.agentId,
      updatedAt: rowModel.updatedAt,
      title: [rowModel.tag, rowModel.title].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' · '),
      path: rowModel.path ?? '',
      annotation:
        resolvedEligibility.eligible && resolvedEligibility.attachStrategy === 'provider_attach' && resolvedEligibility.attachScope === 'remote'
          ? 'remote'
          : null,
      probeable:
        resolvedEligibility.eligible && resolvedEligibility.attachStrategy === 'provider_attach' && resolvedEligibility.attachScope === 'remote',
      disabled:
        resolvedEligibility.eligible && resolvedEligibility.attachStrategy === 'provider_attach' && resolvedEligibility.attachScope === 'remote'
          ? true
          : !resolvedEligibility.eligible,
      disabledReason:
        resolvedEligibility.eligible && resolvedEligibility.attachStrategy === 'provider_attach' && resolvedEligibility.attachScope === 'remote'
          ? 'Press P to check remote reachability.'
          : resolvedEligibility.eligible
            ? null
            : resolvedEligibility.reason,
    });

    if (resolvedEligibility.eligible && resolvedEligibility.attachStrategy === 'provider_attach' && resolvedEligibility.attachScope === 'remote') {
      remoteProviderMetadataBySessionId.set(rowModel.id, {
        agentId: rowModel.agentId,
        metadata: resolvedEligibility.metadata,
      });
    }
  }

  rows.sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    rows,
    probeSessionIdFn: async (sessionId) => {
      const remoteProvider = remoteProviderMetadataBySessionId.get(sessionId);
      if (!remoteProvider) {
        return { reachable: false, reason: 'Remote reachability probe is unavailable for this session.' };
      }

      const providerAttachOps = await getProviderAttachOps(remoteProvider.agentId);
      if (!providerAttachOps?.probeReachability) {
        return { reachable: false, reason: 'Remote reachability probe is unavailable for this provider.' };
      }

      return await providerAttachOps.probeReachability({
        metadata: remoteProvider.metadata,
      });
    },
  };
}
