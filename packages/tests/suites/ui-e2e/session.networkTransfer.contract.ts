export const NETWORK_WORKLOAD_REVISION = 'home-session-network-plain-metadata-v2';
export const NETWORK_PHASES = ['cold-home', 'warm-home', 'home-idle-30s', 'unopened-session-burst', 'session-open', 'session-leave', 'transport-reconnect'] as const;

// L13's three clean repetitions: list GET=1, decoded list=111106, exact GET=0;
// metadata burst=5 received update-session frames / 7455 application bytes. Spread=0.
// These ceilings preserve work-avoided contracts; compression, timers and aggregate
// traffic remain informational. New open/leave/reconnect phases need calibration.
export const NETWORK_CEILINGS = [
  ...(['cold-home', 'warm-home'] as const).flatMap((phase) => [
    { phase, metric: 'GET session-list* requests', maximum: 1 },
    { phase, metric: 'GET session-list* decodedBodyBytes', maximum: 111106 },
    { phase, metric: 'GET exact-session requests', maximum: 0 },
  ]),
  { phase: 'unopened-session-burst', metric: 'WS received update/update-session frames', maximum: 5 },
  { phase: 'unopened-session-burst', metric: 'WS received update/update-session applicationBytes', maximum: 7455 },
] as const;
