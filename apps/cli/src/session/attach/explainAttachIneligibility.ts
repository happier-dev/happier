import { compareMachineHosts } from '@happier-dev/protocol';

import type { CliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

/**
 * Translate a non-eligible attach decision into a stable category + human copy
 * the selector can render under each disabled row, *and* the explicit
 * `happier attach <sessionId>` path can print as a friendly error.
 *
 * Why a separate explainer instead of expanding `evaluateCliSessionAttachEligibility`:
 * - The eligibility evaluator's contract is a *permission* boundary; it
 *   answers "may we attach?" with a structured `reasonCode`. Letting it also
 *   own user-visible prose would tangle two concerns.
 * - The reason copy depends on display-side context the evaluator doesn't
 *   need (current host, tmux availability, agent strategy). Keeping that
 *   coupling here means the evaluator stays minimal.
 * - The attach selector (interactive) and the explicit attach command (single
 *   id) both need the same explanation; a pure helper ensures they can't
 *   drift.
 *
 * Categories are coarser than the evaluator's reason codes on purpose — they
 * group reasons by *what the user can do about it*, which is what the footer
 * hint needs in order to suggest a next step.
 */
export type AttachIneligibilityCategory =
  | 'started_outside_tmux'        // session.terminal.mode === 'plain' on a tmux-strategy agent
  | 'windows_hidden'              // Windows session launched hidden/plain and cannot be attached later
  | 'tmux_unavailable'            // tmux strategy required but tmux not on PATH
  | 'remote_machine'              // session lives on another machine
  | 'machine_identity_mismatch'   // same host, but a different Happier machine id
  | 'no_local_state'              // local-host match, but no local attach state and no provider_attach
  | 'archived_or_inactive'
  | 'metadata_unreadable'
  | 'unsupported_agent';

export type AttachIneligibilityExplanation = Readonly<{
  category: AttachIneligibilityCategory;
  /** One-line, no period, terminal-friendly. Used as the selector sub-line. */
  shortReason: string;
  /** Full sentence ending in a period. Used in footer + explicit-attach error. */
  fullReason: string;
  /**
   * Optional second sentence the explicit-attach path can print to suggest
   * the user's next step. Suppressed in the selector to keep rows compact.
   */
  nextStepHint?: string;
}>;

export type AgentAttachStrategyForExplainer = 'tmux' | 'provider_attach' | 'unsupported' | null;

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMetadataTerminalMode(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const terminal = metadata.terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  const mode = (terminal as Record<string, unknown>).mode;
  return typeof mode === 'string' ? mode : null;
}

function readMetadataTerminalRequested(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const terminal = metadata.terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  const requested = (terminal as Record<string, unknown>).requested;
  return typeof requested === 'string' ? requested : null;
}

/**
 * Decide which category best explains why this row is not attachable.
 *
 * Order matters: we check the most specific, user-actionable causes first
 * (archived, started-outside-tmux), and fall back to coarser causes
 * (remote machine, missing local state) when none of the specific ones fit.
 *
 * The two terminal-mode-aware branches use the *decrypted* metadata, which
 * the evaluator already produces as `eligibility.metadata`. We never trust
 * the plaintext list-row `host` to decide *whether* a session is attachable —
 * the evaluator owns that. Plaintext fields are display-only (see
 * attach selection's "include this row in the list" decision).
 */
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
      fullReason: 'This CLI cannot decrypt this session\'s metadata on this machine.',
      nextStepHint: 'Sign in again with the device that originally created the session, or run `happier auth pair-remote`.',
    };
  }

  if (input.agentAttachStrategy === 'unsupported') {
    return {
      category: 'unsupported_agent',
      shortReason: 'agent does not support attach',
      fullReason: 'This session\'s agent does not support local terminal attach.',
    };
  }

  // Started outside tmux: highest-specificity, most user-actionable case.
  // The session's own metadata records exactly how it was launched. If the
  // mode is `plain` and the agent's attach strategy is `tmux`, we can never
  // re-attach to it — the foreground process has its own TTY, not a tmux
  // pane. This is the case the user just hit and was confused by.
  const terminalMode = readMetadataTerminalMode(input.metadata);
  const terminalRequested = readMetadataTerminalRequested(input.metadata);
  if (
    terminalMode === 'plain'
    && (terminalRequested === 'windows_terminal' || terminalRequested === 'console')
  ) {
    return {
      category: 'windows_hidden',
      shortReason: 'Windows session was started hidden',
      fullReason: eligibility.reason ?? 'This Windows session was started hidden and cannot be attached later.',
      nextStepHint: 'Restart the session with a visible terminal if you need to attach to it later.',
    };
  }

  if (terminalMode === 'plain' && input.agentAttachStrategy === 'tmux') {
    return {
      category: 'started_outside_tmux',
      shortReason: 'started outside tmux',
      fullReason: 'This session was started outside tmux and can\'t be attached.',
      nextStepHint: 'Enable "Spawn Sessions in Tmux" in the Happier app → Session Settings, then start a new session.',
    };
  }

  // tmux is the only supported attach strategy for this agent, but tmux is
  // not installed on this computer. (Distinct from "started outside tmux":
  // here the session might be in a tmux pane elsewhere, we just can't
  // dispatch an `attach` command from this CLI.)
  if (input.agentAttachStrategy === 'tmux' && !input.tmuxAvailable) {
    return {
      category: 'tmux_unavailable',
      shortReason: 'tmux is not installed on this computer',
      fullReason: 'tmux is required to attach to this session, but it isn\'t installed on this computer.',
      nextStepHint: 'Install tmux (e.g. `brew install tmux` on macOS) and retry.',
    };
  }

  // Remote-machine case: distinguish by reading host from decrypted metadata
  // first (auth'd via the encryption key), falling back to current-machine
  // checks the evaluator already did. Note we use `compareMachineHosts` so
  // `mbp` and `mbp.local` are treated as equal.
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

    const remoteSuffix = sessionHost ? ` on ${sessionHost}` : '';
    return {
      category: 'remote_machine',
      shortReason: `running on another machine${remoteSuffix ? ` (${sessionHost})` : ''}`,
      fullReason: sessionHost
        ? `This session is running${remoteSuffix} and can't be attached from this computer.`
        : 'Session belongs to another machine and cannot be attached from this computer.',
      nextStepHint: 'Switch to that machine, or use `happier session list --active` to see all running sessions.',
    };
  }

  // The session has a host that doesn't match this machine even when the
  // evaluator's reason code didn't explicitly say "not_current_machine"
  // (older evaluators or edge cases). Treat that as remote too.
  if (input.currentMachineHost) {
    const sessionHost = readMetadataString(input.metadata, 'host');
    if (sessionHost && !compareMachineHosts(sessionHost, input.currentMachineHost)) {
      return {
        category: 'remote_machine',
        shortReason: `running on ${sessionHost}`,
        fullReason: `This session is running on ${sessionHost} and can't be attached from this computer.`,
        nextStepHint: 'Switch to that machine, or use `happier session list --active` to see all running sessions.',
      };
    }
  }

  // Default for everything else: missing_local_attach_state, current_machine_unknown,
  // session_machine_unknown, provider_attach_unavailable, terminal_not_attachable.
  return {
    category: 'no_local_state',
    shortReason: 'attachment state not available on this computer',
    fullReason: eligibility.reason ?? 'No local attachment state is available for this session on this computer.',
    nextStepHint: 'Start the daemon with `happier daemon start` and retry, or attach from the original terminal.',
  };
}

/**
 * Pick the dominant category among an array of explanations. Used by the
 * footer hint to suggest a next step matched to the most common cause —
 * we don't want to nag about tmux when the actual problem is "all your
 * sessions are on another machine".
 *
 * Returns `null` when the input is empty.
 */
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
