import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

/**
 * The one sentence the story rail's agent step says about a linked Session's
 * live state (r0.42), read from the host's canonical Session awareness
 * projection. The host owns priority, tone and activity; this projection only
 * supplies Triage's story copy inside the host's chosen Work bucket.
 */
export type TriageAgentStatusV1 = Readonly<{
  /** Which of the status sentences this is, so a mark can follow the same decision as the words. */
  kind: TriageAgentStatusKindV1;
  labelKey: string;
  label: string;
  labelParams?: Readonly<Record<string, string>>;
  agent?: SessionStateV1['agent'];
  tone: SessionStateV1['workStatus']['tone'];
  /** The agent is working now; the status pulses (reduced motion keeps it still). */
  live: boolean;
}>;

const COPY = {
  permission: 'Needs your permission',
  action: 'Needs your attention',
  failed: 'Failed',
  working: 'Working',
  input: 'Waiting for your reply',
  ready: 'Ready',
  offline: 'Offline',
  archived: 'Archived',
} as const;

export type TriageAgentStatusKindV1 = keyof typeof COPY;

function status(id: TriageAgentStatusKindV1, state: SessionStateV1): TriageAgentStatusV1 {
  const namedAttention = state.agent !== undefined && state.workStatus.bucket === 'needs_you'
    && (id === 'permission' || id === 'action' || id === 'input');
  return {
    kind: id,
    labelKey: `plugins.triage.surface.detail.agent.${namedAttention ? 'needsYou' : id}`,
    label: namedAttention ? '{agent} needs you' : COPY[id],
    ...(namedAttention ? { labelParams: { agent: state.agent!.displayName } } : {}),
    ...(state.agent === undefined ? {} : { agent: state.agent }),
    tone: state.workStatus.tone,
    live: state.workStatus.bucket === 'working',
  };
}

export function describeTriageAgentStatusV1(state: SessionStateV1): TriageAgentStatusV1 | null {
  switch (state.workStatus.bucket) {
    case 'working': return status('working', state);
    case 'offline': return status('offline', state);
    case 'needs_you':
      switch (state.operational) {
        case 'permission_required': return status('permission', state);
        case 'action_required': return status('action', state);
        case 'pending_input': return status('input', state);
        case 'failed': return status('failed', state);
        default: break;
      }
      break;
    case 'finished':
    case 'idle':
      if (state.lifecycle === 'archived' || state.lifecycle === 'cancelled') return status('archived', state);
      if (state.lifecycle === 'failed') return status('failed', state);
      if (state.operational === 'pending_input') return status('input', state);
      if (state.operational === 'ready') return status('ready', state);
      break;
  }
  return null;
}

/** Which linked Session a list row speaks for: the one asking for the reader, then one at work, then the first that can be said. */
const ROW_AGENT_PRIORITY: readonly SessionStateV1['workStatus']['bucket'][] = ['needs_you', 'working'];

/**
 * The one agent state a PRs & Issues row shows for all of its linked Sessions (the table's Agent column).
 * It reuses the story rail's sentence owner, so a row and its detail never word the same Session differently.
 */
export function readTriageEntryAgentStatusV1(states: readonly SessionStateV1[]): TriageAgentStatusV1 | null {
  for (const bucket of ROW_AGENT_PRIORITY) {
    const match = states.find((state) => state.workStatus.bucket === bucket);
    const described = match === undefined ? null : describeTriageAgentStatusV1(match);
    if (described !== null) return described;
  }
  for (const state of states) {
    const described = describeTriageAgentStatusV1(state);
    if (described !== null) return described;
  }
  return null;
}
