import type { SessionAwarenessProjectionV1 } from './projectionV1.js';

/** The incumbent Session status mapping, shared by Work presentation and input discovery. */
export function readSessionAwarenessWorkStatusV1(input: Readonly<{
  awareness: Readonly<{
    runtime: SessionAwarenessProjectionV1['runtime'];
    operational: Readonly<Pick<SessionAwarenessProjectionV1['operational'], 'primary'>>;
  }>;
  settled?: boolean;
}>): Readonly<{
  bucket: 'needs_you' | 'working' | 'finished' | 'idle' | 'offline';
  tone: 'neutral' | 'attention' | 'danger';
}> {
  const primary = input.awareness.operational.primary;
  if (primary === 'failed') return { bucket: 'needs_you', tone: 'danger' };
  if (primary === 'permission_required' || primary === 'action_required') return { bucket: 'needs_you', tone: 'attention' };
  // A settlement the runtime can no longer stand behind reads offline.
  if (input.awareness.runtime === 'offline') return { bucket: 'offline', tone: 'neutral' };
  if (input.settled === true) return { bucket: 'finished', tone: 'neutral' };
  return { bucket: primary === 'working' ? 'working' : 'idle', tone: 'neutral' };
}

/** Work groups keep idle, finished and offline rows together under Recent. */
export function readSessionWorkStateGroupV1(
  bucket: ReturnType<typeof readSessionAwarenessWorkStatusV1>['bucket'],
): 'needsYou' | 'working' | 'recent' {
  switch (bucket) {
    case 'needs_you': return 'needsYou';
    case 'working': return 'working';
    case 'finished':
    case 'idle':
    case 'offline': return 'recent';
  }
}
