export type SessionEventConsumption = Readonly<{ durableBodies: boolean; liveSegments: boolean }>;
export type SessionEventDelivery = Readonly<{
  delivery: 'full' | 'hint' | 'skip';
  materialization: 'full' | 'projection' | 'stale' | 'none';
}>;

/** Audience and credential admission belong to the caller, before this policy. */
export function classifySessionEventDelivery(params: Readonly<{
  event: 'new-message' | 'message-updated' | 'checkpoint' | 'delta' | 'update-session';
  consumption: SessionEventConsumption;
}>): SessionEventDelivery {
  if (params.consumption.liveSegments) return { delivery: 'full', materialization: 'full' };
  if (params.event === 'checkpoint' || params.event === 'delta') return { delivery: 'skip', materialization: 'none' };
  return {
    delivery: params.consumption.durableBodies ? 'full' : 'hint',
    materialization: params.event === 'new-message' ? 'projection' : 'stale',
  };
}
