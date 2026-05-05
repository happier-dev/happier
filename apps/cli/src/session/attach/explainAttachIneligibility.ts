import { compareMachineHosts } from '@happier-dev/protocol';

import type { CliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

export type AttachIneligibilityCategory =
  | 'started_outside_tmux'
  | 'windows_hidden'
  | 'tmux_unavailable'
  | 'remote_machine'
  | 'machine_identity_mismatch'
  | 'no_local_state'
  | 'archived_or_inactive'
  | 'metadata_unreadable'
  | 'unsupported_agent';

export type AttachIneligibilityExplanation = Readonly<{
  category: AttachIneligibilityCategory;
  shortReason: string;
  fullReason: string;
  nextStepHint?: string;
}>;

export type AgentAttachStrategyForExplainer = 'terminal_host' | 'provider_attach' | 'unsupported' | null;

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMetadataTerminalField(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const terminal = metadata.terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  const value = (terminal as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function explainAttachIneligibility(input: Readonly<{
  eligibility: Extract<CliSessionAttachEligibility, { eligible: false }>;
  metadata: Record<string, unknown> | null;
  currentMachineHost: string | null;
  tmuxAvailable: boolean;
  agentAttachStrategy: AgentAttachStrategyForExplainer;
}>): AttachIneligibilityExplanation {
  const { eligibility } = input;

  if (eligibility.reasonCode === 'archived' || eligibility.reasonCode === 'inactive') {
    return {
      category: 'archived_or_inactive',
      shortReason: eligibility.reasonCode === 'archived' ? 'archived' : 'no longer active',
      fullReason: eligibility.reasonCode === 'archived'
        ? 'This session is archived and cannot be attached.'
        : 'This session is no longer active and cannot be attached.',
      nextStepHint: 'Use `happier resume` to revive a stopped session.',
    };
  }

  if (eligibility.reasonCode === 'metadata_unavailable') {
    return {
      category: 'metadata_unreadable',
      shortReason: 'metadata cannot be decrypted on this machine',
      fullReason: 'This CLI cannot decrypt this session metadata on this machine.',
      nextStepHint: 'Sign in again with the original device, or run `happier auth pair-remote`.',
    };
  }

  if (input.agentAttachStrategy === 'unsupported') {
    return {
      category: 'unsupported_agent',
      shortReason: 'agent does not support attach',
      fullReason: 'This session agent does not support local terminal attach.',
    };
  }

  const terminalMode = readMetadataTerminalField(input.metadata, 'mode');
  const terminalRequested = readMetadataTerminalField(input.metadata, 'requested');
  if (terminalMode === 'plain' && (terminalRequested === 'windows_terminal' || terminalRequested === 'console')) {
    return {
      category: 'windows_hidden',
      shortReason: 'Windows session was started hidden',
      fullReason: eligibility.reason || 'This Windows session was started hidden and cannot be attached later.',
      nextStepHint: 'Restart the session with a visible terminal if you need to attach to it later.',
    };
  }

  if (terminalMode === 'plain' && input.agentAttachStrategy === 'terminal_host') {
    return {
      category: 'started_outside_tmux',
      shortReason: 'started outside tmux',
      fullReason: 'This session was started outside tmux and cannot be attached.',
      nextStepHint: 'Enable "Spawn Sessions in Tmux" in the Happier app Session Settings, then start a new session.',
    };
  }

  if (input.agentAttachStrategy === 'terminal_host' && !input.tmuxAvailable) {
    return {
      category: 'tmux_unavailable',
      shortReason: 'tmux is not installed on this computer',
      fullReason: 'tmux is required to attach to this session, but it is not installed on this computer.',
      nextStepHint: 'Install tmux and retry.',
    };
  }

  if (eligibility.reasonCode === 'not_current_machine') {
    const sessionHost = readMetadataString(input.metadata, 'host');
    if (sessionHost && input.currentMachineHost && compareMachineHosts(sessionHost, input.currentMachineHost)) {
      return {
        category: 'machine_identity_mismatch',
        shortReason: 'different Happier machine identity; no terminal attach target',
        fullReason: 'This session is running on this computer under a different Happier machine identity, but this CLI does not have a tmux target or local attachment marker for it.',
        nextStepHint: 'Use the same Happier app or daemon that started the session, or start a new tmux-backed session from this CLI profile.',
      };
    }

    return {
      category: 'remote_machine',
      shortReason: sessionHost ? `running on another machine (${sessionHost})` : 'running on another machine',
      fullReason: sessionHost
        ? `This session is running on ${sessionHost} and cannot be attached from this computer.`
        : 'Session belongs to another machine and cannot be attached from this computer.',
      nextStepHint: 'Switch to that machine, or use `happier session list --active` to see all running sessions.',
    };
  }

  if (input.currentMachineHost) {
    const sessionHost = readMetadataString(input.metadata, 'host');
    if (sessionHost && !compareMachineHosts(sessionHost, input.currentMachineHost)) {
      return {
        category: 'remote_machine',
        shortReason: `running on ${sessionHost}`,
        fullReason: `This session is running on ${sessionHost} and cannot be attached from this computer.`,
        nextStepHint: 'Switch to that machine, or use `happier session list --active` to see all running sessions.',
      };
    }
  }

  return {
    category: 'no_local_state',
    shortReason: 'attachment state not available on this computer',
    fullReason: eligibility.reason || 'No local attachment state is available for this session on this computer.',
    nextStepHint: 'Start the daemon with `happier daemon start` and retry, or attach from the original terminal.',
  };
}

export function resolveDominantAttachIneligibilityCategory(
  explanations: readonly AttachIneligibilityExplanation[],
): AttachIneligibilityCategory | null {
  if (explanations.length === 0) return null;
  const counts = new Map<AttachIneligibilityCategory, number>();
  for (const explanation of explanations) {
    counts.set(explanation.category, (counts.get(explanation.category) ?? 0) + 1);
  }

  let best: { category: AttachIneligibilityCategory; count: number } | null = null;
  for (const [category, count] of counts) {
    if (!best || count > best.count) best = { category, count };
  }
  return best?.category ?? null;
}
