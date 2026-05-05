export const PEER_TCP_TUNNEL_DISABLED_REASONS = Object.freeze([
    'blocked_by_server_policy',
    'blocked_by_daemon_policy',
    'blocked_by_account_policy',
    'relay_disabled_by_server_policy',
    'relay_cap_exceeded',
    'destination_host_not_allowed',
    'destination_port_not_allowed',
    'grant_missing',
    'grant_expired',
    'grant_revoked',
    'grant_scope_mismatch',
    'probe_binding_mismatch',
    'route_unavailable',
    'server_features_unavailable',
    'receive_window_exceeded',
    'direction_half_closed',
    'encoded_frame_too_large',
    'decoded_payload_too_large',
] as const);

export type PeerTcpTunnelDisabledReason = (typeof PEER_TCP_TUNNEL_DISABLED_REASONS)[number];
