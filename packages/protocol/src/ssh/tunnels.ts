import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const NativeSshTunnelPurposeSchema = lazyZodSchema(() => z.enum(['server-http', 'server-websocket', 'relay-runtime']));
export type NativeSshTunnelPurpose = z.infer<typeof NativeSshTunnelPurposeSchema>;
export const NativeSshTunnelStatusSchema = lazyZodSchema(() => z.enum(['starting', 'ready', 'degraded', 'failed', 'stopped']));
export type NativeSshTunnelStatus = z.infer<typeof NativeSshTunnelStatusSchema>;
export const NativeSshTunnelLeaseSchema = lazyZodSchema(() => z.strictObject({
  leaseId: z.string(), key: z.string(), remoteHostId: z.string(), localUrl: z.optional(z.string()),
  channelMode: z.literal('loopback-port'), purpose: NativeSshTunnelPurposeSchema, status: NativeSshTunnelStatusSchema,
  startedAt: z.string(), expiresAt: z.optional(z.string()),
}));
export type NativeSshTunnelLease = Readonly<z.infer<typeof NativeSshTunnelLeaseSchema>>;
export const NativeSshTunnelLimitationSchema = lazyZodSchema(() => z.strictObject({
  id: z.string(), severity: z.enum(['info', 'warning', 'error']),
  reason: z.enum(['authentication-failed', 'foreground-only', 'host-key-mismatch', 'host-key-rejected', 'host-key-untrusted',
    'loopback-bind-failed', 'native-module-unavailable', 'remote-service-unreachable', 'platform-suspended', 'network-captive-portal']),
  message: z.string(),
}));
export type NativeSshTunnelLimitation = Readonly<z.infer<typeof NativeSshTunnelLimitationSchema>>;
export const NativeSshTunnelSnapshotSchema = lazyZodSchema(() => z.strictObject({
  leases: z.array(NativeSshTunnelLeaseSchema), platformLimitations: z.array(NativeSshTunnelLimitationSchema),
}));
export type NativeSshTunnelSnapshot = Readonly<{
  leases: readonly NativeSshTunnelLease[];
  platformLimitations: readonly NativeSshTunnelLimitation[];
}>;

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

export const SshTunnelPurposeSchema = lazyZodSchema(() => z.enum([
  'remote-host-access',
  'relay-access-local-bridge',
  'bootstrap',
  'diagnostic',
]));
export type SshTunnelPurpose = z.infer<typeof SshTunnelPurposeSchema>;

export const SshTunnelStatusSchema = lazyZodSchema(() => z.enum([
  'available',
  'starting',
  'unavailable',
  'needs-auth',
  'unknown',
]));
export type SshTunnelStatus = z.infer<typeof SshTunnelStatusSchema>;

export const SshTunnelHealthStateSchema = lazyZodSchema(() => z.enum([
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
]));
export type SshTunnelHealthState = z.infer<typeof SshTunnelHealthStateSchema>;

export const SshTunnelSshConnectionConfigSchema = lazyZodSchema(() => z.looseObject({
  target: z.string().check(z.trim(), z.minLength(1)),
  port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))),
  auth: z._default(z.enum(['agent', 'keyfile', 'password']), 'agent'),
  identityFile: z.optional(z.string().check(z.minLength(1))),
  password: z.optional(z.string()),
  sshConfigFile: z.optional(z.string().check(z.minLength(1))),
  knownHostsPath: z.optional(z.string().check(z.minLength(1))),
  trustedHostKey: z.optional(z.string()),
}));
export type SshTunnelSshConnectionConfig = z.infer<typeof SshTunnelSshConnectionConfigSchema>;

export const SshTunnelEnsureRequestSchema = lazyZodSchema(() => z.looseObject({
  remoteHostId: z.optional(z.string().check(z.minLength(1))),
  serverId: z.optional(z.string().check(z.minLength(1))),
  ssh: SshTunnelSshConnectionConfigSchema,
  remoteHost: z.string().check(z.trim(), z.minLength(1)),
  remotePort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  requestedLocalPort: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))),
  purpose: SshTunnelPurposeSchema,
  idleTtlMs: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(24 * 60 * 60 * 1000))),
}));
export type SshTunnelEnsureRequest = z.infer<typeof SshTunnelEnsureRequestSchema>;

export const SshTunnelLeaseSchema = lazyZodSchema(() => z.looseObject({
  leaseId: z.string().check(z.minLength(1)),
  tunnelKey: z.string().check(z.minLength(1)),
  httpBaseUrl: z.string().check(z.url()),
  wsBaseUrl: z.optional(z.string().check(z.url())),
  localPort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  remoteHost: z.string().check(z.minLength(1)),
  remotePort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  expiresAt: z.nullable(z.string().check(z.iso.datetime())),
  status: SshTunnelStatusSchema,
}));
export type SshTunnelLease = z.infer<typeof SshTunnelLeaseSchema>;

export const SshTunnelSnapshotSchema = lazyZodSchema(() => z.looseObject({
  tunnelKey: z.string().check(z.minLength(1)),
  httpBaseUrl: z.string().check(z.url()),
  wsBaseUrl: z.optional(z.string().check(z.url())),
  localPort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  remoteHost: z.string().check(z.minLength(1)),
  remotePort: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  purpose: SshTunnelPurposeSchema,
  remoteHostId: z.optional(z.string().check(z.minLength(1))),
  status: SshTunnelStatusSchema,
  leaseCount: z.number().check(z.int(), z.minimum(0)),
  createdAt: z.string().check(z.iso.datetime()),
  lastProbeAt: z.nullable(z.string().check(z.iso.datetime())),
}));
export type SshTunnelSnapshot = z.infer<typeof SshTunnelSnapshotSchema>;

export const SshTunnelHealthSchema = lazyZodSchema(() => z.looseObject({
  state: SshTunnelHealthStateSchema,
  checkedAt: z.string().check(z.iso.datetime()),
  httpStatus: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
  detail: z.optional(z.string()),
}));
export type SshTunnelHealth = z.infer<typeof SshTunnelHealthSchema>;

export const SshTunnelProbeRequestSchema = lazyZodSchema(() => z.looseObject({
  tunnelKey: z.string().check(z.minLength(1)),
}));
export type SshTunnelProbeRequest = z.infer<typeof SshTunnelProbeRequestSchema>;

export const SshTunnelReleaseRequestSchema = lazyZodSchema(() => z.looseObject({
  leaseId: z.string().check(z.minLength(1)),
}));
export type SshTunnelReleaseRequest = z.infer<typeof SshTunnelReleaseRequestSchema>;

export const SshTunnelStopRequestSchema = lazyZodSchema(() => z.looseObject({
  tunnelKey: z.string().check(z.minLength(1)),
}));
export type SshTunnelStopRequest = z.infer<typeof SshTunnelStopRequestSchema>;

export const SshTunnelErrorCodeSchema = lazyZodSchema(() => z.enum([
  'ssh_tunnel_invalid_request',
  'ssh_tunnel_unavailable',
  'ssh_tunnel_not_found',
  'ssh_tunnel_auth_required',
  'ssh_tunnel_host_key_untrusted',
  'ssh_tunnel_local_port_conflict',
]));
export type SshTunnelErrorCode = z.infer<typeof SshTunnelErrorCodeSchema>;

export const SshTunnelErrorResponseSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(false),
  errorCode: SshTunnelErrorCodeSchema,
  error: z.string().check(z.minLength(1)),
}));
export type SshTunnelErrorResponse = z.infer<typeof SshTunnelErrorResponseSchema>;

export const SshTunnelEnsureResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), lease: SshTunnelLeaseSchema }),
  SshTunnelErrorResponseSchema,
]));
export type SshTunnelEnsureResponse = z.infer<typeof SshTunnelEnsureResponseSchema>;

export const SshTunnelListResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), tunnels: z.array(SshTunnelSnapshotSchema) }),
  SshTunnelErrorResponseSchema,
]));
export type SshTunnelListResponse = z.infer<typeof SshTunnelListResponseSchema>;

export const SshTunnelProbeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), health: SshTunnelHealthSchema }),
  SshTunnelErrorResponseSchema,
]));
export type SshTunnelProbeResponse = z.infer<typeof SshTunnelProbeResponseSchema>;

export const SshTunnelMutationResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  SshTunnelErrorResponseSchema,
]));
export type SshTunnelMutationResponse = z.infer<typeof SshTunnelMutationResponseSchema>;
