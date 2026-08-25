import { z } from 'zod';

import { sanitizeBugReportUrl } from '../bugs/reports/sanitize.js';

const NonEmptyString = z.string().trim().min(1);
const PublicReleaseChannelLabelSchema = z.enum(['stable', 'preview', 'dev']);
const HappierInstallationSourceSchema = z.enum([
  'firstPartyManaged',
  'selfHostManaged',
  'stackManaged',
  'fromSource',
  'npmGlobal',
  'pathBinary',
  'unknown',
]);
const HappierServicePlatformSchema = z.enum(['darwin', 'linux', 'win32']);
const HappierServiceBackendSchema = z.enum([
  'launchd',
  'systemd-user',
  'systemd-system',
  'schtasks-user',
  'schtasks-system',
]);
const HappierServiceVerificationSchema = z.enum(['verified', 'candidate']);
const HappierServiceTargetModeSchema = z.enum(['pinned', 'default-following']);
const DoctorSnapshotAutomaticStartupTargetModeSchema = z.enum(['pinned', 'default-following', 'legacy-pinned']);
const HappierWarningSeveritySchema = z.enum(['info', 'warning', 'error']);
const NonNegativeInteger = z.number().int().nonnegative();

function sanitizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

export const DoctorSnapshotServerProfileSchema = z.object({
  id: NonEmptyString,
  name: NonEmptyString,
  serverUrl: NonEmptyString,
  publicServerUrl: NonEmptyString.optional(),
  webappUrl: NonEmptyString,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number(),
});

export type DoctorSnapshotServerProfile = z.infer<typeof DoctorSnapshotServerProfileSchema>;

export const DoctorSnapshotDaemonStatusSchema = z.object({
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
  }),
  auth: z.object({
    authenticated: z.boolean(),
    machineRegistered: z.boolean(),
    machineId: NonEmptyString.nullable(),
    needsAuth: z.boolean(),
    accountId: NonEmptyString.nullable(),
  }),
});

export type DoctorSnapshotDaemonStatus = z.infer<typeof DoctorSnapshotDaemonStatusSchema>;

export const HappierDoctorActiveInvocationSchema = z.object({
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  invokerName: NonEmptyString.nullable(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  installationId: NonEmptyString.nullable(),
});

export const HappierDoctorInstallationSchema = z.object({
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
});

export const HappierDoctorInstallationInventorySchema = z.object({
  activeInvocation: HappierDoctorActiveInvocationSchema.nullable(),
  installations: z.array(HappierDoctorInstallationSchema),
});

export const HappierDoctorServiceSchema = z.object({
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
});

export const HappierDoctorServiceInventorySchema = z.object({
  services: z.array(HappierDoctorServiceSchema),
});

export const DoctorSnapshotRepairSummarySchema = z.object({
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
}).passthrough();

export const DoctorSnapshotLocalRelaySchema = z.object({
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
}).passthrough();

export const DoctorSnapshotLocalRelayInventorySchema = z.object({
  relays: z.array(DoctorSnapshotLocalRelaySchema),
}).passthrough();

export const DoctorSnapshotAutomaticStartupEntrySchema = z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
  targetMode: DoctorSnapshotAutomaticStartupTargetModeSchema.optional(),
  scope: z.enum(['user', 'system']),
  installed: z.boolean(),
  running: z.boolean().nullable(),
  definitionPath: NonEmptyString.nullable().optional(),
  relayUrl: NonEmptyString.nullable().optional(),
}).passthrough();

export const DoctorSnapshotAutomaticStartupSummarySchema = z.object({
  entries: z.array(DoctorSnapshotAutomaticStartupEntrySchema),
  defaultFollowingCount: NonNegativeInteger.optional(),
  pinnedCount: NonNegativeInteger.optional(),
}).passthrough();

export const DoctorSnapshotActiveStackSummarySchema = z.object({
  activeServerId: NonEmptyString,
  releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
  relayUrl: NonEmptyString,
  publicRelayUrl: NonEmptyString.optional(),
  localRelayUrl: NonEmptyString.nullable().optional(),
  source: NonEmptyString.optional(),
}).passthrough();

export const DoctorSnapshotServiceHealthSchema = z.object({
  backgroundService: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    healthy: z.boolean().nullable(),
    serviceLabel: NonEmptyString.nullable().optional(),
    releaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
    relayUrl: NonEmptyString.nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

export const HappierDoctorWarningSchema = z.object({
  code: NonEmptyString,
  severity: HappierWarningSeveritySchema,
  message: NonEmptyString,
  repairCommands: z.array(NonEmptyString),
});

export const DoctorSnapshotSchema = z.object({
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
  warnings: z.array(HappierDoctorWarningSchema).optional(),
});

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
