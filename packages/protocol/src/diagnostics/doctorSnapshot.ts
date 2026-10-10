import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { sanitizeBugReportUrl } from '../bugs/reports/sanitize.js';

const NonEmptyString = z.string().trim().min(1);
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
const NonNegativeInteger = z.number().int().nonnegative();

const DoctorSnapshotTransportObservationSchema = lazyZodSchema(() => z.object({
  carrier: z.enum(['https', 'iroh']).optional(),
  /** Omitted when native reports `unknown`; diagnostics never infer a path. */
  observedPath: z.enum(['direct', 'relay']).optional(),
}));

export const DoctorSnapshotHomeTransportDiagnosticsSchema = lazyZodSchema(() => z.object({
  homeServerIdentityId: NonEmptyString,
  /** Remote Home transport identity; public diagnostic metadata, never a key. */
  remoteEndpointId: NonEmptyString.max(256).optional(),
  state: z.enum(['connecting', 'connected', 'reconnecting', 'unavailable', 'disconnected', 'unknown']),
  /** Exact configuration applied by the native owner, when that owner has supplied it. */
  effectiveConfiguration: z.object({
    policy: z.enum(['automatic', 'disabled']),
    relayUrls: z.array(z.string().trim().min(1).max(2_048)).max(16),
    /** Total applied relays; present when relayUrls is a bounded projection. */
    relayUrlCount: NonNegativeInteger.optional(),
    /** Explicitly marks that relayUrls omits applied entries. */
    relayUrlsTruncated: z.boolean().optional(),
    directAddressCount: NonNegativeInteger,
  }).optional(),
  /** Current proven carrier/path facts. Unknown facts are omitted. */
  current: DoctorSnapshotTransportObservationSchema.optional(),
  /** Most recent proven carrier/path facts, retained across degradation or closure. */
  lastKnown: DoctorSnapshotTransportObservationSchema.optional(),
  lastTransitionAtMs: z.number().int().nonnegative().optional(),
  diagnosticError: z.object({
    code: NonEmptyString.max(256),
    message: NonEmptyString.max(1_024).optional(),
    atMs: z.number().int().nonnegative(),
  }).optional(),
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
  publicServerUrl: NonEmptyString.optional(),
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
    localServerUrl: NonEmptyString.nullable(),
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
    comparableKey: NonEmptyString.nullable(),
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
    healthy: z.boolean().nullable().optional(),
    pid: z.number().int().positive().nullable(),
    httpPort: z.number().int().positive().nullable(),
    startedWithCliVersion: NonEmptyString.optional(),
    startedWithPublicReleaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
    runtimeId: NonEmptyString.optional(),
    startupSource: NonEmptyString.optional(),
    serviceManaged: z.boolean().nullable().optional(),
    serviceLabel: NonEmptyString.nullable().optional(),
  }),
  service: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    autostart: z.enum(['at-login', 'on-demand']).nullable().optional(),
  }),
  auth: z.object({
    authenticated: z.boolean(),
    /** Current server validation fact. Stored bytes alone are never `valid`. */
    credentialState: z.enum(['missing', 'valid', 'invalid', 'unknown']).optional(),
    machineRegistered: z.boolean(),
    /** Distinguishes a locally allocated identity from one accepted by the server. */
    machineRegistrationState: z.enum(['no-local-id', 'local-only', 'server-confirmed']).optional(),
    machineId: NonEmptyString.nullable(),
    needsAuth: z.boolean(),
    accountId: NonEmptyString.nullable(),
    /** Readable label of the validated account (username, else display name); never an email. */
    accountLabel: NonEmptyString.nullable().optional(),
  }),
}));

export type DoctorSnapshotDaemonStatus = z.infer<typeof DoctorSnapshotDaemonStatusSchema>;

export const HappierDoctorActiveInvocationSchema = lazyZodSchema(() => z.object({
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  invokerName: NonEmptyString.nullable(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  installationId: NonEmptyString.nullable(),
}));

export const HappierDoctorInstallationSchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  source: HappierInstallationSourceSchema,
  components: z.array(NonEmptyString).min(1),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  shimName: NonEmptyString.nullable(),
  onPath: z.boolean(),
  managedRoot: NonEmptyString.nullable(),
}));

export const HappierDoctorInstallationInventorySchema = lazyZodSchema(() => z.object({
  activeInvocation: HappierDoctorActiveInvocationSchema.nullable(),
  installations: z.array(HappierDoctorInstallationSchema),
}));

export const HappierDoctorServiceSchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  serviceType: NonEmptyString,
  platform: HappierServicePlatformSchema,
  backend: HappierServiceBackendSchema,
  label: NonEmptyString,
  verification: HappierServiceVerificationSchema,
  targetMode: HappierServiceTargetModeSchema.optional(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  instanceId: NonEmptyString.nullable(),
  scope: z.enum(['user', 'system']),
  definitionPath: NonEmptyString,
  executablePath: NonEmptyString.nullable(),
  serverUrl: NonEmptyString.nullable().optional(),
  publicServerUrl: NonEmptyString.nullable().optional(),
  installed: z.boolean(),
  running: z.boolean(),
}));

export const HappierDoctorServiceInventorySchema = lazyZodSchema(() => z.object({
  services: z.array(HappierDoctorServiceSchema),
}));

export const DoctorSnapshotRepairSummarySchema = lazyZodSchema(() => z.object({
  schemaVersion: z.number().int().positive().optional(),
  status: z.enum(['ok', 'needs_attention', 'blocked', 'unknown']).optional(),
  findingCounts: z.object({
    total: NonNegativeInteger,
    info: NonNegativeInteger.optional(),
    warning: NonNegativeInteger.optional(),
    error: NonNegativeInteger.optional(),
    actionable: NonNegativeInteger.optional(),
    autoRepairable: NonNegativeInteger.optional(),
  }).optional(),
  findingKinds: z.array(NonEmptyString).optional(),
  generatedAt: NonEmptyString.optional(),
}).passthrough());

export const DoctorSnapshotLocalRelaySchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema,
  relayUrl: NonEmptyString.nullable(),
  version: NonEmptyString.nullable(),
  installed: z.boolean(),
  running: z.boolean().nullable(),
  healthy: z.boolean().nullable(),
  serviceEnabled: z.boolean().nullable().optional(),
  port: z.number().int().positive().nullable().optional(),
  installRoot: NonEmptyString.nullable().optional(),
}).passthrough());

export const DoctorSnapshotLocalRelayInventorySchema = lazyZodSchema(() => z.object({
  relays: z.array(DoctorSnapshotLocalRelaySchema),
}).passthrough());

export const DoctorSnapshotAutomaticStartupEntrySchema = lazyZodSchema(() => z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
  targetMode: DoctorSnapshotAutomaticStartupTargetModeSchema.optional(),
  scope: z.enum(['user', 'system']),
  installed: z.boolean(),
  running: z.boolean().nullable(),
  definitionPath: NonEmptyString.nullable().optional(),
  relayUrl: NonEmptyString.nullable().optional(),
}).passthrough());

export const DoctorSnapshotAutomaticStartupSummarySchema = lazyZodSchema(() => z.object({
  entries: z.array(DoctorSnapshotAutomaticStartupEntrySchema),
  defaultFollowingCount: NonNegativeInteger.optional(),
  pinnedCount: NonNegativeInteger.optional(),
}).passthrough());

export const DoctorSnapshotActiveStackSummarySchema = lazyZodSchema(() => z.object({
  activeServerId: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
  relayUrl: NonEmptyString,
  publicRelayUrl: NonEmptyString.optional(),
  localRelayUrl: NonEmptyString.nullable().optional(),
  source: NonEmptyString.optional(),
}).passthrough());

export const DoctorSnapshotServiceHealthSchema = lazyZodSchema(() => z.object({
  backgroundService: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    healthy: z.boolean().nullable(),
    serviceLabel: NonEmptyString.nullable().optional(),
    releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
    relayUrl: NonEmptyString.nullable().optional(),
  }).passthrough().optional(),
}).passthrough());

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
  accountId: NonEmptyString.nullable(),
  settings: z.object({
    activeServerId: NonEmptyString.nullable(),
    servers: z.array(DoctorSnapshotServerProfileSchema),
    knownAccountIds: z.array(NonEmptyString),
  }),
  daemonStatus: DoctorSnapshotDaemonStatusSchema.optional(),
  installations: z.object({
    happier: HappierDoctorInstallationInventorySchema.optional(),
  }).optional(),
  services: z.object({
    happier: HappierDoctorServiceInventorySchema.optional(),
  }).optional(),
  repairSummary: DoctorSnapshotRepairSummarySchema.optional(),
  localRelays: DoctorSnapshotLocalRelayInventorySchema.optional(),
  automaticStartup: DoctorSnapshotAutomaticStartupSummarySchema.optional(),
  activeStack: DoctorSnapshotActiveStackSummarySchema.optional(),
  serviceHealth: DoctorSnapshotServiceHealthSchema.optional(),
  homeTransports: z.array(DoctorSnapshotHomeTransportDiagnosticsSchema).optional(),
  warnings: z.array(HappierDoctorWarningSchema).optional(),
}));

export type DoctorSnapshot = z.infer<typeof DoctorSnapshotSchema>;

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
