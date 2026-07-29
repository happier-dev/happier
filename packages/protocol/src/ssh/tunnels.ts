import { z } from 'zod';

export const SSH_TUNNEL_SYSTEM_TASK_KINDS = Object.freeze({
  ensure: 'daemon.sshTunnel.ensure.v1',
  list: 'daemon.sshTunnel.list.v1',
  release: 'daemon.sshTunnel.release.v1',
  stop: 'daemon.sshTunnel.stop.v1',
} as const);
export const SSH_TUNNEL_SYSTEM_TASK_KIND_IDS = Object.freeze([
  SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure,
  SSH_TUNNEL_SYSTEM_TASK_KINDS.list,
  SSH_TUNNEL_SYSTEM_TASK_KINDS.release,
  SSH_TUNNEL_SYSTEM_TASK_KINDS.stop,
] as const);
export type SshTunnelSystemTaskKind = typeof SSH_TUNNEL_SYSTEM_TASK_KIND_IDS[number];

export const SshTunnelPurposeSchema = z.enum([
  'remote-host-access',
  'relay-access-local-bridge',
  'bootstrap',
  'diagnostic',
]);
export type SshTunnelPurpose = z.infer<typeof SshTunnelPurposeSchema>;

export const SshTunnelStatusSchema = z.enum([
  'available',
  'starting',
  'unavailable',
  'needs-auth',
  'unknown',
]);
export type SshTunnelStatus = z.infer<typeof SshTunnelStatusSchema>;

export const SshTunnelHealthStateSchema = z.enum([
  'healthy',
  'starting',
  'local_port_unreachable',
  'ssh_process_unavailable',
  'remote_runtime_unavailable',
  'auth_required',
  'host_key_untrusted',
  'local_port_conflict',
  'stale_control_socket',
  'unknown',
]);
export type SshTunnelHealthState = z.infer<typeof SshTunnelHealthStateSchema>;

export const SshTunnelSshConnectionConfigSchema = z.object({
  target: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535).optional(),
  auth: z.enum(['agent', 'keyfile', 'password']).default('agent'),
  identityFile: z.string().min(1).optional(),
  password: z.string().optional(),
  sshConfigFile: z.string().min(1).optional(),
  knownHostsPath: z.string().min(1).optional(),
  trustedHostKey: z.string().optional(),
}).passthrough();
export type SshTunnelSshConnectionConfig = z.infer<typeof SshTunnelSshConnectionConfigSchema>;

export const SshTunnelEnsureRequestSchema = z.object({
  remoteHostId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  ssh: SshTunnelSshConnectionConfigSchema,
  remoteHost: z.string().trim().min(1),
  remotePort: z.number().int().min(1).max(65_535),
  requestedLocalPort: z.number().int().min(1).max(65_535).optional(),
  purpose: SshTunnelPurposeSchema,
  idleTtlMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
}).passthrough();
export type SshTunnelEnsureRequest = z.infer<typeof SshTunnelEnsureRequestSchema>;

export const SshTunnelLeaseSchema = z.object({
  leaseId: z.string().min(1),
  tunnelKey: z.string().min(1),
  httpBaseUrl: z.string().url(),
  wsBaseUrl: z.string().url().optional(),
  localPort: z.number().int().min(1).max(65_535),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65_535),
  expiresAt: z.string().datetime().nullable(),
  status: SshTunnelStatusSchema,
}).passthrough();
export type SshTunnelLease = z.infer<typeof SshTunnelLeaseSchema>;

export const SshTunnelSnapshotSchema = z.object({
  tunnelKey: z.string().min(1),
  httpBaseUrl: z.string().url(),
  wsBaseUrl: z.string().url().optional(),
  localPort: z.number().int().min(1).max(65_535),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65_535),
  purpose: SshTunnelPurposeSchema,
  remoteHostId: z.string().min(1).optional(),
  status: SshTunnelStatusSchema,
  leaseCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  lastProbeAt: z.string().datetime().nullable(),
}).passthrough();
export type SshTunnelSnapshot = z.infer<typeof SshTunnelSnapshotSchema>;

export const SshTunnelHealthSchema = z.object({
  state: SshTunnelHealthStateSchema,
  checkedAt: z.string().datetime(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  detail: z.string().optional(),
}).passthrough();
export type SshTunnelHealth = z.infer<typeof SshTunnelHealthSchema>;

export const SshTunnelProbeRequestSchema = z.object({
  tunnelKey: z.string().min(1),
}).passthrough();
export type SshTunnelProbeRequest = z.infer<typeof SshTunnelProbeRequestSchema>;

export const SshTunnelReleaseRequestSchema = z.object({
  leaseId: z.string().min(1),
}).passthrough();
export type SshTunnelReleaseRequest = z.infer<typeof SshTunnelReleaseRequestSchema>;

export const SshTunnelStopRequestSchema = z.object({
  tunnelKey: z.string().min(1),
}).passthrough();
export type SshTunnelStopRequest = z.infer<typeof SshTunnelStopRequestSchema>;

export const SshTunnelErrorCodeSchema = z.enum([
  'ssh_tunnel_invalid_request',
  'ssh_tunnel_unavailable',
  'ssh_tunnel_not_found',
  'ssh_tunnel_auth_required',
  'ssh_tunnel_host_key_untrusted',
  'ssh_tunnel_local_port_conflict',
]);
export type SshTunnelErrorCode = z.infer<typeof SshTunnelErrorCodeSchema>;

export const SshTunnelErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: SshTunnelErrorCodeSchema,
  error: z.string().min(1),
}).passthrough();
export type SshTunnelErrorResponse = z.infer<typeof SshTunnelErrorResponseSchema>;

export const SshTunnelEnsureResponseSchema = z.union([
  z.object({ ok: z.literal(true), lease: SshTunnelLeaseSchema }).passthrough(),
  SshTunnelErrorResponseSchema,
]);
export type SshTunnelEnsureResponse = z.infer<typeof SshTunnelEnsureResponseSchema>;

export const SshTunnelListResponseSchema = z.union([
  z.object({ ok: z.literal(true), tunnels: z.array(SshTunnelSnapshotSchema) }).passthrough(),
  SshTunnelErrorResponseSchema,
]);
export type SshTunnelListResponse = z.infer<typeof SshTunnelListResponseSchema>;

export const SshTunnelProbeResponseSchema = z.union([
  z.object({ ok: z.literal(true), health: SshTunnelHealthSchema }).passthrough(),
  SshTunnelErrorResponseSchema,
]);
export type SshTunnelProbeResponse = z.infer<typeof SshTunnelProbeResponseSchema>;

export const SshTunnelMutationResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  SshTunnelErrorResponseSchema,
]);
export type SshTunnelMutationResponse = z.infer<typeof SshTunnelMutationResponseSchema>;
