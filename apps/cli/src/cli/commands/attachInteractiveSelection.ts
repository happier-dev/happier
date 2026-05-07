import { getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';
import { compareMachineHosts } from '@happier-dev/protocol';
import type { AccountSettings } from '@happier-dev/protocol';

import { getProviderAttachOps } from '@/backends/catalog';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { evaluateCliSessionAttachEligibility } from '@/session/attach/evaluateCliSessionAttachEligibility';
import type { CliSessionAttachEligibility } from '@/session/attach/evaluateCliSessionAttachEligibility';
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
  /**
   * Most common reason rows are not attachable. Drives the footer copy in
   * the selector — see `formatAttachIneligibilityFooter` for the
   * category-to-text mapping.
   */
  dominantCategory: AttachIneligibilityCategory | null;
  attachableCount: number;
  ineligibleCount: number;
  /**
   * The effective "spawn sessions in tmux" preference for the current
   * machine, mirroring the UI's `resolveTerminalSpawnOptions` resolver.
   * `null` when account settings could not be loaded.
   */
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

/**
 * Decide whether to *show* this row in the attach selector. This is a display
 * gate, not an attachability gate — `evaluateCliSessionAttachEligibility` is
 * the only thing that decides whether the user can actually attach.
 *
 * Inclusion signals:
 * - `localInfo` exists → unambiguously this machine.
 * - decrypted `metadata.machineId === currentMachineId` → authoritative
 *   "this machine" signal, gated by the e2ee key.
 * - decrypted `metadata.host` matches `currentMachineHost` (after
 *   `compareMachineHosts` normalisation) → display-only proxy when machineId
 *   is missing, useful for older sessions and codex/plain sessions where
 *   machineId may not be populated.
 * - agent uses `provider_attach` → opencode-style sessions can be reached
 *   regardless of host.
 */
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
  credentials: Credentials;
  currentMachineId: string | null;
  currentMachineHost: string;
  fetchSessionsPageFn: FetchSessionsPageFn;
  readTerminalAttachmentInfoFn: ReadTerminalAttachmentInfoFn;
  isTmuxAvailableFn: IsTmuxAvailableFn;
  accountSettings: AccountSettings | null;
}>): Promise<AttachSelectionModel> {
  const page = await params.fetchSessionsPageFn({
    token: params.credentials.token,
    limit: 200,
    activeOnly: true,
  });
  const tmuxAvailable = await params.isTmuxAvailableFn();
  const rows: SessionActionSelectorRow[] = [];
  const ineligibilityExplanations: AttachIneligibilityExplanation[] = [];
  const remoteProviderMetadataBySessionId = new Map<string, { agentId: AgentId; metadata: Record<string, unknown> }>();

  for (const rawSession of page.sessions) {
    const rowModel = buildCliSessionRowModel({ credentials: params.credentials, rawSession });
    if (rowModel.isSystem) continue;

    const localInfo = await params.readTerminalAttachmentInfoFn({
      happyHomeDir: configuration.happyHomeDir,
      sessionId: rawSession.id,
    });

    const eligibility: CliSessionAttachEligibility = await evaluateCliSessionAttachEligibility({
      credentials: params.credentials,
      rawSession,
      currentMachineId: params.currentMachineId,
      currentMachineHost: params.currentMachineHost,
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });

    const metadata = eligibility.metadata ?? null;
    const metadataMachineId = readMetadataString(metadata, 'machineId');
    const metadataHost = readMetadataString(metadata, 'host');
    const agentAttachStrategy = resolveAgentAttachStrategy(rowModel.agentId);

    const include = shouldIncludeRowInSelector({
      hasLocalInfo: localInfo !== null,
      metadataMachineId,
      currentMachineId: params.currentMachineId,
      metadataHost,
      currentMachineHost: params.currentMachineHost,
      agentAttachStrategy,
    });
    if (!include) continue;

    if (eligibility.eligible) {
      // Attachable, including the special remote-provider-attach case where
      // the user can press P to probe reachability before committing.
      const isRemoteProviderAttach =
        eligibility.attachStrategy === 'provider_attach' && eligibility.attachScope === 'remote';

      if (isRemoteProviderAttach) {
        remoteProviderMetadataBySessionId.set(rowModel.id, {
          agentId: rowModel.agentId as AgentId,
          metadata: eligibility.metadata,
        });
      }

      rows.push({
        sessionId: rowModel.id,
        agentId: rowModel.agentId,
        updatedAt: rowModel.updatedAt,
        title: [rowModel.tag, rowModel.title].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' · '),
        path: rowModel.path ?? '',
        annotation: isRemoteProviderAttach ? 'remote' : null,
        probeable: isRemoteProviderAttach,
        // Remote provider-attach rows start disabled until the user proves
        // reachability with `P` — the selector's probe handler flips them
        // to `disabled: false` on success.
        disabled: isRemoteProviderAttach ? true : false,
        disabledReason: isRemoteProviderAttach ? 'Press P to check remote reachability.' : null,
      });
      continue;
    }

    // Not eligible — show the row, but mark it disabled with the reason so
    // the user understands *why* this otherwise-running session can't be
    // attached.
    const explanation = explainAttachIneligibility({
      eligibility,
      metadata,
      currentMachineHost: params.currentMachineHost,
      tmuxAvailable,
      agentAttachStrategy,
    });
    ineligibilityExplanations.push(explanation);

    rows.push({
      sessionId: rowModel.id,
      agentId: rowModel.agentId,
      updatedAt: rowModel.updatedAt,
      title: [rowModel.tag, rowModel.title].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' · '),
      path: rowModel.path ?? '',
      annotation: explanation.shortReason,
      probeable: false,
      disabled: true,
      disabledReason: explanation.fullReason,
    });
  }

  // Attachable rows first (newest first within group), disabled rows after
  // (newest first within group). Matches the user's spec: ready-to-attach at
  // the top, can't-attach below with reasons.
  rows.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return b.updatedAt - a.updatedAt;
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

/**
 * Render the contextual footer hint shown under the selector's keyboard
 * help. Stays silent when there's nothing actionable to say (e.g. the user
 * has eligible sessions and no inelegible-but-running ones).
 */
export function formatAttachIneligibilityFooter(hint: AttachSelectionFooterHint): string | null {
  if (hint.ineligibleCount === 0) return null;

  const tmux = hint.effectiveSessionTmux;
  const ineligible = hint.ineligibleCount;
  const sessionWord = ineligible === 1 ? 'session' : 'sessions';
  const beVerb = ineligible === 1 ? 'is' : 'are';

  switch (hint.dominantCategory) {
    case 'started_outside_tmux': {
      if (tmux && !tmux.useTmux) {
        const scope = tmux.source === 'machine-override'
          ? 'on this computer'
          : '';
        return `${ineligible} ${sessionWord} on this machine were started outside tmux and can't be attached. `
          + `Enable “Spawn Sessions in Tmux”${scope ? ` ${scope}` : ''} in the Happier app → Session Settings, then start a new session.`;
      }
      return `${ineligible} ${sessionWord} on this machine were started before "Spawn Sessions in Tmux" was enabled. `
        + `New sessions you start now will be attachable.`;
    }
    case 'tmux_unavailable':
      return `tmux isn't installed on this computer. Install tmux (e.g. \`brew install tmux\` on macOS) to make codex/claude sessions attachable.`;
    case 'windows_hidden':
      return `${ineligible} hidden Windows ${sessionWord} can't be attached after start. `
        + `Restart ${ineligible === 1 ? 'it' : 'them'} with a visible terminal if you need to attach later.`;
    case 'machine_identity_mismatch':
      return `${ineligible} ${sessionWord} ${beVerb} running on this computer under a different Happier machine identity, but no tmux target or local attachment marker is available. `
        + `Use the same Happier app or daemon that started ${ineligible === 1 ? 'it' : 'them'}, or start a new tmux-backed session from this CLI profile.`;
    case 'remote_machine':
      return `${ineligible} ${sessionWord} ${beVerb} running on other machines. Use \`happier session list --active\` to see all running sessions.`;
    case 'no_local_state':
      return `${ineligible} ${sessionWord} ${beVerb} running but ${ineligible === 1 ? 'its' : 'their'} local attachment state isn't visible. `
        + `Try \`happier daemon start\` and re-run, or attach from the original terminal.`;
    case 'archived_or_inactive':
      return `${ineligible} ${sessionWord} ${beVerb} no longer active. Use \`happier resume\` to revive a stopped session.`;
    case 'metadata_unreadable':
      return `${ineligible} ${sessionWord} can't be decrypted on this machine. Sign in on the original device or pair this one with \`happier auth pair-remote\`.`;
    case 'unsupported_agent':
      return `${ineligible} ${sessionWord} use an agent that doesn't support local terminal attach.`;
    default:
      return null;
  }
}
