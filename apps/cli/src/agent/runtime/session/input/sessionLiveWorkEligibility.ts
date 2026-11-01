import type { SessionInputLiveWork } from './_types';

export type SessionLiveWorkItem = Readonly<{
  category: string;
  state: SessionInputLiveWork['session'];
  settledAt?: number;
  activeCount?: number;
}>;
export type SessionActivityEligibilityReason = Readonly<{
  kind: 'working' | 'waiting_for_you' | 'subagents_running' | 'activity_unknown';
  count?: number;
}>;

/** One projection serves local admission and the daemon's private inventory. */
export function projectSessionLiveWorkItems(activity: SessionInputLiveWork): readonly (SessionLiveWorkItem & { category: 'session' | 'input' | 'agents' | 'attention' })[] {
  return [
    { category: 'session', state: activity.session, ...(activity.settledAt !== undefined ? { settledAt: activity.settledAt } : {}) },
    { category: 'input', state: activity.input },
    { category: 'agents', state: activity.agents ?? 'unknown', ...(activity.agentsActiveCount !== undefined ? { activeCount: activity.agentsActiveCount } : {}) },
    { category: 'attention', state: activity.attention ?? 'unknown' },
  ];
}

/** Guard-specific draft, resumability and protection policies remain with the guard. */
export function readSessionLiveWorkEligibility(items: readonly SessionLiveWorkItem[]): Readonly<
  { eligible: true; settledAt: number } | { eligible: false; reasons: readonly SessionActivityEligibilityReason[] }
> {
  const settledAt = items.find(item => item.category === 'session')?.settledAt;
  const reasons: SessionActivityEligibilityReason[] = [];
  if (items.some(item => item.state === 'unknown') || settledAt === undefined
    || !Number.isSafeInteger(settledAt) || settledAt < 0) reasons.push({ kind: 'activity_unknown' });
  for (const item of items) {
    if (item.state !== 'active') continue;
    const reason: SessionActivityEligibilityReason = item.category === 'attention' ? { kind: 'waiting_for_you' }
      : item.category === 'agents' ? { kind: 'subagents_running', ...(item.activeCount !== undefined ? { count: item.activeCount } : {}) }
      : { kind: 'working' };
    if (!reasons.some(existing => existing.kind === reason.kind)) reasons.push(reason);
  }
  return reasons.length || settledAt === undefined ? { eligible: false, reasons } : { eligible: true, settledAt };
}
