import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

/**
 * The one sentence the story rail's agent step says about a linked Session's
 * live state (r0.42), read from the host's canonical Session awareness
 * projection. The host owns priority, tone and activity; this projection only
 * supplies Triage's story copy inside the host's chosen Work bucket.
 */
export type TriageAgentStatusV1 = Readonly<{
  labelKey: string;
  label: string;
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

function status(id: keyof typeof COPY, state: SessionStateV1): TriageAgentStatusV1 {
  return {
    labelKey: `plugins.triage.surface.detail.agent.${id}`,
    label: COPY[id],
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
