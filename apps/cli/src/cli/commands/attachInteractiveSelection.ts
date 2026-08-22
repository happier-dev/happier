import {
  getAgentLocalControlCapability,
  type AgentId,
  type AttachSessionMetadataV1,
} from '@happier-dev/agents';
import { compareMachineHosts, type AccountSettings } from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import {
  buildCliSessionRowModel,
  UNKNOWN_CLI_SESSION_AGENT_LABEL,
} from '@/cli/output/session/buildCliSessionRowModel';
import {
  explainAttachIneligibility,
  resolveDominantAttachIneligibilityCategory,
  type AgentAttachStrategyForExplainer,
  type AttachIneligibilityCategory,
  type AttachIneligibilityExplanation,
} from '@/session/attach/explainAttachIneligibility';
import {
  resolveEffectiveSessionTmuxFromAccountSettings,
  type EffectiveSessionTmuxResolution,
} from '@/session/attach/resolveEffectiveSessionTmuxFromAccountSettings';
import { resolveCliSessionAttachBackendId } from '@/session/attach/resolveCliSessionAttachBackendId';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
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

type IsTmuxAvailableFn = () => Promise<boolean>;

export type AttachSelectionFooterHint = Readonly<{
  dominantCategory: AttachIneligibilityCategory | null;
  attachableCount: number;
  ineligibleCount: number;
  effectiveSessionTmux: EffectiveSessionTmuxResolution | null;
}>;

export type AttachSelectionModel = Readonly<{
  rows: SessionActionSelectorRow[];
  hint: AttachSelectionFooterHint;
  probeSessionIdFn: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>;

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveAgentAttachStrategy(agentId: AgentId | string | null | undefined): AgentAttachStrategyForExplainer {
  if (!agentId) return null;
  const capability = getAgentLocalControlCapability(agentId as AgentId);
  if (!capability) return 'unsupported';
  return capability.attachStrategy;
}

function resolveAttachStrategyForEligibility(input: Readonly<{
  eligibility: Awaited<ReturnType<ReturnType<typeof getSessionHostBridge>['evaluateAttachEligibility']>>;
  fallbackAgentId: AgentId | string | null | undefined;
}>): AgentAttachStrategyForExplainer {
  if (input.eligibility.eligible) {
    return input.eligibility.attachStrategy;
  }
  if (input.eligibility.reasonCode === 'provider_attach_unavailable') {
    return 'provider_attach';
  }
  return resolveAgentAttachStrategy(input.fallbackAgentId);
}

function shouldIncludeRowInSelector(input: Readonly<{
  hasLocalInfo: boolean;
  metadataMachineId: string | null;
  currentMachineId: string | null;
  metadataHost: string | null;
  currentMachineHost: string | null;
  agentAttachStrategy: AgentAttachStrategyForExplainer;
}>): boolean {
  if (input.hasLocalInfo) return true;
  if (input.metadataMachineId && input.currentMachineId && input.metadataMachineId === input.currentMachineId) return true;
  if (input.agentAttachStrategy === 'provider_attach') return true;
  if (compareMachineHosts(input.metadataHost, input.currentMachineHost)) return true;
  return false;
}

export async function buildAttachSelectionModel(params: Readonly<{
  credentials: StoredCredentials;
  currentMachineId: string | null;
  currentMachineHost: string | null;
  fetchSessionsPageFn: FetchSessionsPageFn;
  readTerminalAttachmentInfoFn: ReadTerminalAttachmentInfoFn;
  isTmuxAvailableFn: IsTmuxAvailableFn;
  accountSettings?: AccountSettings | null;
  accountEncryptionMode: 'plain' | 'e2ee';
}>): Promise<AttachSelectionModel> {
  const sessionHostBridge = getSessionHostBridge();
  const page = await params.fetchSessionsPageFn({
    token: params.credentials.token,
    limit: 200,
    activeOnly: true,
  });
  const tmuxAvailable = await params.isTmuxAvailableFn();
  const rows: SessionActionSelectorRow[] = [];
  const ineligibilityExplanations: AttachIneligibilityExplanation[] = [];
  const remoteProviderMetadataBySessionId = new Map<string, {
    backendId: string;
    metadata: AttachSessionMetadataV1;
  }>();
  for (const rawSession of page.sessions) {
    const rowModel = buildCliSessionRowModel({
      credentials: params.credentials,
      rawSession,
      accountEncryptionMode: params.accountEncryptionMode,
    });
    if (rowModel.isSystem) continue;

    const localInfo = await params.readTerminalAttachmentInfoFn({
      happyHomeDir: configuration.happyHomeDir,
      sessionId: rawSession.id,
    });
    const eligibility = sessionHostBridge.evaluateAttachEligibility({
      credentials: params.credentials,
      rawSession,
      accountEncryptionMode: params.accountEncryptionMode,
      currentMachineId: params.currentMachineId,
      currentMachineHost: params.currentMachineHost,
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });
    const resolvedEligibility = await eligibility;

    const metadata = resolvedEligibility.metadata ?? null;
    const metadataMachineId = readMetadataString(metadata, 'machineId');
    const metadataHost = readMetadataString(metadata, 'host');
    const agentAttachStrategy = resolveAttachStrategyForEligibility({
      eligibility: resolvedEligibility,
      fallbackAgentId: rowModel.agentId,
    });
    if (!shouldIncludeRowInSelector({
      hasLocalInfo: localInfo !== null,
      metadataMachineId,
      currentMachineId: params.currentMachineId,
      metadataHost,
      currentMachineHost: params.currentMachineHost,
      agentAttachStrategy,
    })) continue;

    const isRemoteProviderAttach =
      resolvedEligibility.eligible
      && resolvedEligibility.attachStrategy === 'provider_attach'
      && resolvedEligibility.attachScope === 'remote';

    if (isRemoteProviderAttach) {
      const backendId = resolveCliSessionAttachBackendId(resolvedEligibility.metadata);
      remoteProviderMetadataBySessionId.set(rowModel.id, {
        backendId: backendId ?? rowModel.agentId ?? UNKNOWN_CLI_SESSION_AGENT_LABEL,
        metadata: resolvedEligibility.metadata,
      });
    }

    const explanation = resolvedEligibility.eligible ? null : explainAttachIneligibility({
      eligibility: resolvedEligibility,
      metadata,
      currentMachineHost: params.currentMachineHost,
      tmuxAvailable,
      agentAttachStrategy,
    });
    if (explanation) ineligibilityExplanations.push(explanation);

    rows.push({
      sessionId: rowModel.id,
      agentId: rowModel.agentId ?? UNKNOWN_CLI_SESSION_AGENT_LABEL,
      updatedAt: rowModel.updatedAt,
      title: [rowModel.tag, rowModel.title].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' · '),
      path: rowModel.path ?? '',
      annotation: isRemoteProviderAttach ? 'remote' : explanation?.shortReason ?? null,
      probeable: isRemoteProviderAttach,
      disabled: isRemoteProviderAttach ? true : !resolvedEligibility.eligible,
      disabledReason: isRemoteProviderAttach
        ? 'Press P to check remote reachability.'
        : explanation?.fullReason ?? null,
    });
  }

  rows.sort((left, right) => {
    if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
    return right.updatedAt - left.updatedAt;
  });

  const hint: AttachSelectionFooterHint = {
    dominantCategory: resolveDominantAttachIneligibilityCategory(ineligibilityExplanations),
    attachableCount: rows.filter((row) => !row.disabled).length,
    ineligibleCount: ineligibilityExplanations.length,
    effectiveSessionTmux: resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: params.accountSettings,
      currentMachineId: params.currentMachineId,
    }),
  };

  return {
    rows,
    hint,
    probeSessionIdFn: async (sessionId) => {
      const remoteProvider = remoteProviderMetadataBySessionId.get(sessionId);
      if (!remoteProvider) {
        return { reachable: false, reason: 'Remote reachability probe is unavailable for this session.' };
      }

      const providerAttachSurface = (await sessionHostBridge.resolveExecutionSurfaces(remoteProvider.backendId)).attach;
      if (!providerAttachSurface?.evaluateAvailability) {
        return { reachable: false, reason: 'Remote reachability probe is unavailable for this provider.' };
      }

      const availability = await providerAttachSurface.evaluateAvailability({
        operation: 'attach',
        sessionId,
        metadata: remoteProvider.metadata,
        depth: 'live',
      });
      return availability.available
        ? { reachable: true }
        : {
            reachable: false,
            reason: availability.safeMessage ?? 'Provider attach target is unreachable.',
          };
    },
  };
}

export function formatAttachIneligibilityFooter(hint: AttachSelectionFooterHint): string | null {
  if (hint.ineligibleCount === 0) return null;

  const ineligible = hint.ineligibleCount;
  const sessionWord = ineligible === 1 ? 'session' : 'sessions';
  const beVerb = ineligible === 1 ? 'is' : 'are';
  switch (hint.dominantCategory) {
    case 'started_outside_tmux':
      if (hint.effectiveSessionTmux && !hint.effectiveSessionTmux.useTmux) {
        const scope = hint.effectiveSessionTmux.source === 'machine-override' ? ' on this computer' : '';
        return `${ineligible} ${sessionWord} on this machine were started outside tmux and cannot be attached. Enable "Spawn Sessions in Tmux"${scope} in the Happier app Session Settings, then start a new session.`;
      }
      return `${ineligible} ${sessionWord} on this machine were started before "Spawn Sessions in Tmux" was enabled. New sessions you start now will be attachable.`;
    case 'tmux_unavailable':
      return 'tmux is not installed on this computer. Install tmux to make terminal-hosted sessions attachable.';
    case 'windows_hidden':
      return `${ineligible} hidden Windows ${sessionWord} cannot be attached after start. Restart ${ineligible === 1 ? 'it' : 'them'} with a visible terminal if you need to attach later.`;
    case 'machine_identity_mismatch':
      return `${ineligible} ${sessionWord} ${beVerb} running on this computer under a different Happier machine identity, but no tmux target or local attachment marker is available. Use the same Happier app or daemon that started ${ineligible === 1 ? 'it' : 'them'}, or start a new tmux-backed session from this CLI profile.`;
    case 'remote_machine':
      return `${ineligible} ${sessionWord} ${beVerb} running on other machines. Use \`happier session list --active\` to see all running sessions.`;
    case 'no_local_state':
      return `${ineligible} ${sessionWord} ${beVerb} running but ${ineligible === 1 ? 'its' : 'their'} local attachment state is not visible. Try \`happier daemon start\` and rerun, or attach from the original terminal.`;
    case 'archived_or_inactive':
      return `${ineligible} ${sessionWord} ${beVerb} no longer active. Use \`happier resume\` to revive a stopped session.`;
    case 'metadata_unreadable':
      return `${ineligible} ${sessionWord} cannot be decrypted on this machine. Sign in on the original device or pair this one with \`happier auth pair-remote\`.`;
    case 'unsupported_agent':
      return `${ineligible} ${sessionWord} use an agent that does not support local terminal attach.`;
    default:
      return null;
  }
}
