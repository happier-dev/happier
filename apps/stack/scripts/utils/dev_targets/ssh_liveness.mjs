// OpenSSH keepalive for sessions that must outlive ordinary transport stalls
// but end when their peer is gone: managed guest transports and admitted
// command payloads. The client probes only after this much inbound silence
// (payload output resets it), so a quiet payload on a live host never expires.
// A silent peer ends the session after about intervalSeconds x countMax; a
// rebooted peer resets the connection at the first probe after it returns.
// The shorter 15 s x 3 budget expired 57 admitted nl1/nl3 payloads during one
// controller-wide stall (2026-11-04 14:16Z); with keepalive off, 16 payloads to
// rebooted linux1 stayed established for hours (2026-11-17).
export const LONG_LIVED_SSH_SERVER_ALIVE = Object.freeze({ intervalSeconds: 30, countMax: 6 });
