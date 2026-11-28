import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { sanitizeBugReportUrl } from '../bugs/reports/sanitize.js';
import { MachineVitalsSampleV1Schema } from '../machines/vitals/machineVitalsSampleV1.js';
import { MachineResourceAttentionV1Schema } from '../machines/resources/machineResourceSummaryV1.js';

const NonEmptyString = z.string().check(z.trim(), z.minLength(1));
const PublicReleaseChannelLabelSchema = lazyZodSchema(() => z.enum(['stable', 'preview', 'dev']));
const HappierInstallationSourceSchema = lazyZodSchema(() => z.enum([
  'firstPartyManaged',
  'selfHostManaged',
  'stackManaged',
  'fromSource',
  'npmGlobal',
  'pathBinary',
  'unknown',
]));
const HappierServicePlatformSchema = lazyZodSchema(() => z.enum(['darwin', 'linux', 'win32']));
const HappierServiceBackendSchema = lazyZodSchema(() => z.enum([
  'launchd',
  'systemd-user',
  'systemd-system',
  'schtasks-user',
  'schtasks-system',
]));
const HappierServiceVerificationSchema = lazyZodSchema(() => z.enum(['verified', 'candidate']));
const HappierServiceTargetModeSchema = lazyZodSchema(() => z.enum(['pinned', 'default-following']));
const DoctorSnapshotAutomaticStartupTargetModeSchema = lazyZodSchema(() => z.enum(['pinned', 'default-following', 'legacy-pinned']));
const HappierWarningSeveritySchema = lazyZodSchema(() => z.enum(['info', 'warning', 'error']));
const NonNegativeInteger = z.number().check(z.int(), z.nonnegative());

export const DoctorDaemonSelfVitalsSchema = lazyZodSchema(() => z.strictObject({
  sampledAt: NonNegativeInteger,
  eventLoopBusyFraction: z.nullable(z.number().check(z.minimum(0), z.maximum(1))),
  rssBytes: NonNegativeInteger,
  heapUsedBytes: NonNegativeInteger,
  heapTotalBytes: NonNegativeInteger,
  activeHandleCount: z.nullable(NonNegativeInteger),
  unavailableReason: z.optional(z.literal('runtime_not_reported')),
}));
export type DoctorDaemonSelfVitals = z.infer<typeof DoctorDaemonSelfVitalsSchema>;

export const DoctorSnapshotResourceVitalsSchema = lazyZodSchema(() => z.strictObject({
  sample: z.nullable(MachineVitalsSampleV1Schema),
  attention: z.nullable(MachineResourceAttentionV1Schema),
  self: DoctorDaemonSelfVitalsSchema,
}));
export type DoctorSnapshotResourceVitals = z.infer<typeof DoctorSnapshotResourceVitalsSchema>;

const DoctorSnapshotTransportObservationSchema = lazyZodSchema(() => z.object({
  carrier: z.optional(z.enum(['https', 'iroh'])),
  /** Omitted when native reports `unknown`; diagnostics never infer a path. */
  observedPath: z.optional(z.enum(['direct', 'relay'])),
}));

export const DoctorSnapshotHomeTransportDiagnosticsSchema = lazyZodSchema(() => z.object({
  homeServerIdentityId: NonEmptyString,
  /** Remote Home transport identity; public diagnostic metadata, never a key. */
  remoteEndpointId: z.optional(NonEmptyString.check(z.maxLength(256))),
  state: z.enum(['connecting', 'connected', 'reconnecting', 'unavailable', 'disconnected', 'unknown']),
  /** Exact configuration applied by the native owner, when that owner has supplied it. */
  effectiveConfiguration: z.optional(z.object({
    policy: z.enum(['automatic', 'disabled']),
    relayUrls: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048))).check(z.maxLength(16)),
    /** Total applied relays; present when relayUrls is a bounded projection. */
    relayUrlCount: z.optional(NonNegativeInteger),
    /** Explicitly marks that relayUrls omits applied entries. */
    relayUrlsTruncated: z.optional(z.boolean()),
    directAddressCount: NonNegativeInteger,
  })),
  /** Current proven carrier/path facts. Unknown facts are omitted. */
  current: z.optional(DoctorSnapshotTransportObservationSchema),
  /** Most recent proven carrier/path facts, retained across degradation or closure. */
  lastKnown: z.optional(DoctorSnapshotTransportObservationSchema),
  lastTransitionAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  diagnosticError: z.optional(z.object({
    code: NonEmptyString.check(z.maxLength(256)),
    message: z.optional(NonEmptyString.check(z.maxLength(1_024))),
    atMs: z.number().check(z.int(), z.nonnegative()),
  })),
}));

export type DoctorSnapshotHomeTransportDiagnostics = z.infer<typeof DoctorSnapshotHomeTransportDiagnosticsSchema>;

function sanitizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

function redactDoctorDiagnosticSecrets(value: string): string {
  return value
    // Complete Authorization values (`Authorization: Bearer <secret>`,
    // `authorization=Basic <secret>`): consume the credential that follows the auth scheme.
    // The keyed rule below alone would stop at the scheme word and publish the credential
    // that follows it into the copied snapshot or UI projection.
    .replace(
      /(["']?)\b(authorization)\b\1\s*[:=]\s*(["']?)(?:(?:bearer|basic)\s+)?[^\s,;}"']+\3/giu,
      '$2=[redacted]',
    )
    // Standalone Bearer/Basic credentials without an Authorization key.
    .replace(/\b(bearer|basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    // Keyed secrets, including common compound and camel-case forms emitted by
    // HTTP/OAuth libraries (`access_token`, `api_key`, `authToken`, ...).
    .replace(
      /(["']?)\b(access[-_]?token|refresh[-_]?token|auth[-_]?token|api[-_]?key|client[-_]?secret|token|key|password|secret|private[-_ ]?key|proof)\b\1\s*[:=]\s*(["']?)[^\s,;}"']+\3/giu,
      '$2=[redacted]',
    );
}

/**
 * Canonical privacy boundary for copied/exported diagnostic text. It retains
 * useful technical detail and line structure while removing credential-shaped
 * values and URL userinfo/query/fragment data.
 */
export function sanitizeDoctorDiagnosticText(value: string): string {
  const withoutSecrets = redactDoctorDiagnosticSecrets(String(value ?? ''));
  const withoutUrlSecrets = withoutSecrets.replace(
    /https?:\/\/[^\s]+/giu,
    (url) => sanitizeBugReportUrl(url) ?? '[invalid-url]',
  );
  return withoutUrlSecrets
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim();
}

export function sanitizeDoctorDiagnosticErrorCode(code: string): string {
  const withoutControls = redactDoctorDiagnosticSecrets(String(code ?? ''))
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();
  return withoutControls.slice(0, 256) || 'unknown';
}

export function sanitizeDoctorDiagnosticErrorMessage(message: string): string {
  return sanitizeDoctorDiagnosticText(message).replace(/[\r\n]+/gu, ' ').trim().slice(0, 1_024)
    || 'Unknown transport error';
}

export const DoctorSnapshotServerProfileSchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  name: NonEmptyString,
  serverUrl: NonEmptyString,
  publicServerUrl: z.optional(NonEmptyString),
  webappUrl: NonEmptyString,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number(),
}));

export type DoctorSnapshotServerProfile = z.infer<typeof DoctorSnapshotServerProfileSchema>;

export const DoctorSnapshotDaemonStatusSchema = lazyZodSchema(() => z.object({
  server: z.object({
    activeServerId: NonEmptyString,
    serverUrl: NonEmptyString,
    localServerUrl: z.nullable(NonEmptyString),
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
    comparableKey: z.nullable(NonEmptyString),
  }),
  daemon: z.object({
    /** The daemon process exists. Answers "is something there", never "does it work". */
    running: z.boolean(),
    /**
     * Whether the daemon can actually serve the machine RPCs the product drives it with,
     * as the daemon itself last reported it — not as an observer inferred it from a PID.
     *
     * `true` the daemon published a completed machine-control RPC registration;
     * `false` it published that the registration is outstanding (a live process that
     *   cannot serve a single machine RPC — the 2026-08-24 pid-26058 outage state);
     * `null`/absent the daemon published no such fact, so health is **unknown**. Unknown is
     *   never treated as unhealthy, and nothing may act destructively on either value.
     */
    healthy: z.optional(z.nullable(z.boolean())),
    pid: z.nullable(z.number().check(z.int(), z.positive())),
    httpPort: z.nullable(z.number().check(z.int(), z.positive())),
    startedWithCliVersion: z.optional(NonEmptyString),
    startedWithPublicReleaseChannel: z.optional(z.nullable(PublicReleaseChannelLabelSchema)),
    runtimeId: z.optional(NonEmptyString),
    startupSource: z.optional(NonEmptyString),
    serviceManaged: z.optional(z.nullable(z.boolean())),
    serviceLabel: z.optional(z.nullable(NonEmptyString)),
  }),
  service: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    autostart: z.optional(z.nullable(z.enum(['at-login', 'on-demand']))),
  }),
  auth: z.object({
    authenticated: z.boolean(),
    /** Current server validation fact. Stored bytes alone are never `valid`. */
    credentialState: z.optional(z.enum(['missing', 'valid', 'invalid', 'unknown'])),
    machineRegistered: z.boolean(),
    /** Distinguishes a locally allocated identity from one accepted by the server. */
    machineRegistrationState: z.optional(z.enum(['no-local-id', 'local-only', 'server-confirmed'])),
    machineId: z.nullable(NonEmptyString),
    needsAuth: z.boolean(),
    accountId: z.nullable(NonEmptyString),
    /** Readable label of the validated account (username, else display name); never an email. */
    accountLabel: z.optional(z.nullable(NonEmptyString)),
  }),
}));

export type DoctorSnapshotDaemonStatus = z.infer<typeof DoctorSnapshotDaemonStatusSchema>;

export const HappierDoctorActiveInvocationSchema = lazyZodSchema(() => z.object({
  path: NonEmptyString,
  realPath: z.nullable(NonEmptyString),
  invokerName: z.nullable(NonEmptyString),
  ring: z.nullable(PublicReleaseChannelLabelSchema),
  version: z.nullable(NonEmptyString),
  installationId: z.nullable(NonEmptyString),
}));

export const HappierDoctorInstallationSchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  source: HappierInstallationSourceSchema,
  components: z.array(NonEmptyString).check(z.minLength(1)),
  ring: z.nullable(PublicReleaseChannelLabelSchema),
  version: z.nullable(NonEmptyString),
  path: NonEmptyString,
  realPath: z.nullable(NonEmptyString),
  shimName: z.nullable(NonEmptyString),
  onPath: z.boolean(),
  managedRoot: z.nullable(NonEmptyString),
}));

export const HappierDoctorInstallationInventorySchema = lazyZodSchema(() => z.object({
  activeInvocation: z.nullable(HappierDoctorActiveInvocationSchema),
  installations: z.array(HappierDoctorInstallationSchema),
}));

export const HappierDoctorServiceSchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  serviceType: NonEmptyString,
  platform: HappierServicePlatformSchema,
  backend: HappierServiceBackendSchema,
  label: NonEmptyString,
  verification: HappierServiceVerificationSchema,
  targetMode: z.optional(HappierServiceTargetModeSchema),
  ring: z.nullable(PublicReleaseChannelLabelSchema),
  instanceId: z.nullable(NonEmptyString),
  scope: z.enum(['user', 'system']),
  definitionPath: NonEmptyString,
  executablePath: z.nullable(NonEmptyString),
  serverUrl: z.optional(z.nullable(NonEmptyString)),
  publicServerUrl: z.optional(z.nullable(NonEmptyString)),
  installed: z.boolean(),
  running: z.boolean(),
}));

export const HappierDoctorServiceInventorySchema = lazyZodSchema(() => z.object({
  services: z.array(HappierDoctorServiceSchema),
}));

export const DoctorSnapshotRepairSummarySchema = lazyZodSchema(() => z.looseObject({
  schemaVersion: z.optional(z.number().check(z.int(), z.positive())),
  status: z.optional(z.enum(['ok', 'needs_attention', 'blocked', 'unknown'])),
  findingCounts: z.optional(z.object({
    total: NonNegativeInteger,
    info: z.optional(NonNegativeInteger),
    warning: z.optional(NonNegativeInteger),
    error: z.optional(NonNegativeInteger),
    actionable: z.optional(NonNegativeInteger),
    autoRepairable: z.optional(NonNegativeInteger),
  })),
  findingKinds: z.optional(z.array(NonEmptyString)),
  generatedAt: z.optional(NonEmptyString),
}));

export const DoctorSnapshotLocalRelaySchema = lazyZodSchema(() => z.looseObject({
  id: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema,
  relayUrl: z.nullable(NonEmptyString),
  version: z.nullable(NonEmptyString),
  installed: z.boolean(),
  running: z.nullable(z.boolean()),
  healthy: z.nullable(z.boolean()),
  serviceEnabled: z.optional(z.nullable(z.boolean())),
  port: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
  installRoot: z.optional(z.nullable(NonEmptyString)),
}));

export const DoctorSnapshotLocalRelayInventorySchema = lazyZodSchema(() => z.looseObject({
  relays: z.array(DoctorSnapshotLocalRelaySchema),
}));

export const DoctorSnapshotAutomaticStartupEntrySchema = lazyZodSchema(() => z.looseObject({
  id: NonEmptyString,
  label: NonEmptyString,
  releaseChannel: z.optional(z.nullable(PublicReleaseChannelLabelSchema)),
  targetMode: z.optional(DoctorSnapshotAutomaticStartupTargetModeSchema),
  scope: z.enum(['user', 'system']),
  installed: z.boolean(),
  running: z.nullable(z.boolean()),
  definitionPath: z.optional(z.nullable(NonEmptyString)),
  relayUrl: z.optional(z.nullable(NonEmptyString)),
}));

export const DoctorSnapshotAutomaticStartupSummarySchema = lazyZodSchema(() => z.looseObject({
  entries: z.array(DoctorSnapshotAutomaticStartupEntrySchema),
  defaultFollowingCount: z.optional(NonNegativeInteger),
  pinnedCount: z.optional(NonNegativeInteger),
}));

export const DoctorSnapshotActiveStackSummarySchema = lazyZodSchema(() => z.looseObject({
  activeServerId: NonEmptyString,
  releaseChannel: z.optional(z.nullable(PublicReleaseChannelLabelSchema)),
  relayUrl: NonEmptyString,
  publicRelayUrl: z.optional(NonEmptyString),
  localRelayUrl: z.optional(z.nullable(NonEmptyString)),
  source: z.optional(NonEmptyString),
}));

export const DoctorSnapshotServiceHealthSchema = lazyZodSchema(() => z.looseObject({
  backgroundService: z.optional(z.looseObject({
    installed: z.boolean(),
    running: z.boolean(),
    healthy: z.nullable(z.boolean()),
    serviceLabel: z.optional(z.nullable(NonEmptyString)),
    releaseChannel: z.optional(z.nullable(PublicReleaseChannelLabelSchema)),
    relayUrl: z.optional(z.nullable(NonEmptyString)),
  })),
}));

export const HappierDoctorWarningSchema = lazyZodSchema(() => z.object({
  code: NonEmptyString,
  severity: HappierWarningSeveritySchema,
  message: NonEmptyString,
  repairCommands: z.array(NonEmptyString),
}));

export const DoctorSnapshotSchema = lazyZodSchema(() => z.object({
  capturedAt: NonEmptyString,
  server: z.object({
    activeServerId: NonEmptyString,
    serverUrl: NonEmptyString,
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
  }),
  accountId: z.nullable(NonEmptyString),
  settings: z.object({
    activeServerId: z.nullable(NonEmptyString),
    servers: z.array(DoctorSnapshotServerProfileSchema),
    knownAccountIds: z.array(NonEmptyString),
  }),
  daemonStatus: z.optional(DoctorSnapshotDaemonStatusSchema),
  resourceVitals: z.optional(DoctorSnapshotResourceVitalsSchema),
  installations: z.optional(z.object({
    happier: z.optional(HappierDoctorInstallationInventorySchema),
  })),
  services: z.optional(z.object({
    happier: z.optional(HappierDoctorServiceInventorySchema),
  })),
  repairSummary: z.optional(DoctorSnapshotRepairSummarySchema),
  localRelays: z.optional(DoctorSnapshotLocalRelayInventorySchema),
  automaticStartup: z.optional(DoctorSnapshotAutomaticStartupSummarySchema),
  activeStack: z.optional(DoctorSnapshotActiveStackSummarySchema),
  serviceHealth: z.optional(DoctorSnapshotServiceHealthSchema),
  homeTransports: z.optional(z.array(DoctorSnapshotHomeTransportDiagnosticsSchema)),
  warnings: z.optional(z.array(HappierDoctorWarningSchema)),
}));

export type DoctorSnapshot = z.infer<typeof DoctorSnapshotSchema>;

/** Machine health for Action callers. Open diagnostics never cross this boundary. */
export const MachineDoctorSnapshotActionResultV1Schema = lazyZodSchema(() => z.strictObject({
  capturedAt: NonEmptyString,
  daemon: z.nullable(z.strictObject({ running: z.boolean(), healthy: z.nullable(z.boolean()) })),
  backgroundService: z.nullable(z.strictObject({
    installed: z.boolean(), running: z.boolean(), healthy: z.nullable(z.boolean()),
  })),
}));

export function projectMachineDoctorSnapshotForAction(snapshot: DoctorSnapshot):
    z.infer<typeof MachineDoctorSnapshotActionResultV1Schema> {
  const daemon = snapshot.daemonStatus?.daemon;
  const service = snapshot.serviceHealth?.backgroundService;
  return {
    capturedAt: snapshot.capturedAt,
    daemon: daemon ? { running: daemon.running, healthy: daemon.healthy ?? null } : null,
    backgroundService: service ? { installed: service.installed, running: service.running, healthy: service.healthy } : null,
  };
}

export function sanitizeDoctorSnapshotUrls(snapshot: DoctorSnapshot): DoctorSnapshot {
  return {
    ...snapshot,
    server: {
      ...snapshot.server,
      serverUrl: sanitizeUrl(snapshot.server.serverUrl),
      publicServerUrl: sanitizeUrl(snapshot.server.publicServerUrl),
      webappUrl: sanitizeUrl(snapshot.server.webappUrl),
    },
    settings: {
      ...snapshot.settings,
      servers: snapshot.settings.servers.map((entry) => ({
        ...entry,
        serverUrl: sanitizeUrl(entry.serverUrl),
        publicServerUrl: entry.publicServerUrl ? sanitizeUrl(entry.publicServerUrl) : undefined,
        webappUrl: sanitizeUrl(entry.webappUrl),
      })),
    },
    daemonStatus: snapshot.daemonStatus
      ? {
          ...snapshot.daemonStatus,
          server: {
            ...snapshot.daemonStatus.server,
            serverUrl: sanitizeUrl(snapshot.daemonStatus.server.serverUrl),
            localServerUrl: snapshot.daemonStatus.server.localServerUrl
              ? sanitizeUrl(snapshot.daemonStatus.server.localServerUrl)
              : null,
            publicServerUrl: sanitizeUrl(snapshot.daemonStatus.server.publicServerUrl),
            webappUrl: sanitizeUrl(snapshot.daemonStatus.server.webappUrl),
          },
        }
      : undefined,
    services: snapshot.services
      ? {
          ...snapshot.services,
          happier: snapshot.services.happier
            ? {
                ...snapshot.services.happier,
                services: snapshot.services.happier.services.map((entry) => ({
                  ...entry,
                  serverUrl: entry.serverUrl ? sanitizeUrl(entry.serverUrl) : entry.serverUrl,
                  publicServerUrl: entry.publicServerUrl ? sanitizeUrl(entry.publicServerUrl) : entry.publicServerUrl,
                })),
              }
            : undefined,
        }
      : undefined,
    localRelays: snapshot.localRelays
      ? {
          ...snapshot.localRelays,
          relays: snapshot.localRelays.relays.map((entry) => ({
            ...entry,
            relayUrl: entry.relayUrl ? sanitizeUrl(entry.relayUrl) : entry.relayUrl,
          })),
        }
      : undefined,
    automaticStartup: snapshot.automaticStartup
      ? {
          ...snapshot.automaticStartup,
          entries: snapshot.automaticStartup.entries.map((entry) => ({
            ...entry,
            relayUrl: entry.relayUrl ? sanitizeUrl(entry.relayUrl) : entry.relayUrl,
          })),
        }
      : undefined,
    activeStack: snapshot.activeStack
      ? {
          ...snapshot.activeStack,
          relayUrl: sanitizeUrl(snapshot.activeStack.relayUrl),
          publicRelayUrl: snapshot.activeStack.publicRelayUrl
            ? sanitizeUrl(snapshot.activeStack.publicRelayUrl)
            : undefined,
          localRelayUrl: snapshot.activeStack.localRelayUrl
            ? sanitizeUrl(snapshot.activeStack.localRelayUrl)
            : snapshot.activeStack.localRelayUrl,
        }
      : undefined,
    serviceHealth: snapshot.serviceHealth
      ? {
          ...snapshot.serviceHealth,
          backgroundService: snapshot.serviceHealth.backgroundService
            ? {
                ...snapshot.serviceHealth.backgroundService,
                relayUrl: snapshot.serviceHealth.backgroundService.relayUrl
                  ? sanitizeUrl(snapshot.serviceHealth.backgroundService.relayUrl)
                  : snapshot.serviceHealth.backgroundService.relayUrl,
              }
            : undefined,
        }
      : undefined,
    homeTransports: snapshot.homeTransports?.map((transport) => ({
      ...transport,
      effectiveConfiguration: transport.effectiveConfiguration
        ? {
            ...transport.effectiveConfiguration,
            relayUrls: transport.effectiveConfiguration.relayUrls.map((url) => sanitizeUrl(url)),
          }
        : undefined,
      diagnosticError: transport.diagnosticError
        ? {
            ...transport.diagnosticError,
            code: sanitizeDoctorDiagnosticErrorCode(transport.diagnosticError.code),
            message: transport.diagnosticError.message
              ? sanitizeDoctorDiagnosticErrorMessage(transport.diagnosticError.message)
              : undefined,
          }
        : undefined,
    })),
  };
}

export function parseDoctorSnapshotSafe(raw: string): { ok: true; snapshot: DoctorSnapshot } | { ok: false; error: string } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Missing doctor snapshot JSON' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  const result = DoctorSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: 'Invalid doctor snapshot schema' };
  }

  return { ok: true, snapshot: sanitizeDoctorSnapshotUrls(result.data) };
}
