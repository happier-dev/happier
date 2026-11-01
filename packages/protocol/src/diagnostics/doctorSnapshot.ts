import { z } from 'zod';

import { sanitizeBugReportUrl } from '../bugReports/sanitize.js';
import { CliUpdateFactsSchema } from '../machines/cliUpdateFacts.js';
import { lazySchema } from '../lazySchema.js';

const NonEmptyString = lazySchema(() => z.string().trim().min(1));
const PublicReleaseChannelLabelSchema = lazySchema(() => z.enum(['stable', 'preview', 'dev']));
const HappierInstallationSourceSchema = lazySchema(() => z.enum([
  'firstPartyManaged',
  'selfHostManaged',
  'stackManaged',
  'fromSource',
  'npmGlobal',
  'pathBinary',
  'unknown',
]));
const HappierServicePlatformSchema = lazySchema(() => z.enum(['darwin', 'linux', 'win32']));
const HappierServiceBackendSchema = lazySchema(() => z.enum([
  'launchd',
  'systemd-user',
  'systemd-system',
  'schtasks-user',
  'schtasks-system',
]));
const HappierServiceVerificationSchema = lazySchema(() => z.enum(['verified', 'candidate']));
const HappierServiceTargetModeSchema = lazySchema(() => z.enum(['pinned', 'default-following']));
/** The CLI's own autostart vocabulary (`DaemonServiceAutostartMode`), not a boolean. */
const HappierServiceAutostartModeSchema = lazySchema(() => z.enum(['at-login', 'on-demand']));
const HappierWarningSeveritySchema = lazySchema(() => z.enum(['info', 'warning', 'error']));

function sanitizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

export const DoctorSnapshotServerProfileSchema = lazySchema(() => z.object({
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

export const DoctorSnapshotDaemonCredentialStateSchema = lazySchema(() => z.enum(['missing', 'rejected', 'valid', 'unknown']));

export type DoctorSnapshotDaemonCredentialState = z.infer<typeof DoctorSnapshotDaemonCredentialStateSchema>;

/**
 * Facts about the daemon that is actually running, derived by the CLI from its
 * authenticated control endpoint and owner evaluation rather than from the files
 * beside it. Optional because older CLIs did not emit it.
 */
export const DoctorSnapshotDaemonRuntimeConvergenceSchema = lazySchema(() => z.object({
  controlReachable: z.boolean(),
  serviceOwnsRunningDaemon: z.boolean(),
  machineIdMatches: z.boolean(),
  cliVersionMatches: z.boolean(),
}));

export type DoctorSnapshotDaemonRuntimeConvergence = z.infer<typeof DoctorSnapshotDaemonRuntimeConvergenceSchema>;

export const DoctorSnapshotDaemonStatusSchema = lazySchema(() => z.object({
  server: z.object({
    activeServerId: NonEmptyString,
    serverUrl: NonEmptyString,
    localServerUrl: NonEmptyString.nullable(),
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
    comparableKey: NonEmptyString.nullable(),
  }),
  daemon: z.object({
    running: z.boolean(),
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
    /**
     * Whether the installed background service follows the default relay or is pinned to one
     * profile. `null` means no readable definition proved a mode; absent means the CLI that
     * answered predates this field. Neither may be read as `default-following`.
     */
    targetMode: HappierServiceTargetModeSchema.nullable().optional(),
    /**
     * Whether the installed background service starts the daemon at login. `null` means the
     * installed definition declared no mode; absent means the CLI that answered predates this
     * field. Neither may be read as `at-login`.
     */
    autostart: HappierServiceAutostartModeSchema.nullable().optional(),
  }),
  auth: z.object({
    authenticated: z.boolean(),
    machineRegistered: z.boolean(),
    machineId: NonEmptyString.nullable(),
    needsAuth: z.boolean(),
    accountId: NonEmptyString.nullable(),
    credentialState: DoctorSnapshotDaemonCredentialStateSchema.optional(),
    validatedAccountId: NonEmptyString.nullable().optional(),
    /**
     * How the validated account's profile names it for people (username, else display name), so
     * a surface can say which account this computer is signed in as. `null` when the relay did
     * not validate the token or the profile has no name; absent from older CLIs.
     */
    accountLabel: NonEmptyString.nullable().optional(),
  }),
  runtimeConvergence: DoctorSnapshotDaemonRuntimeConvergenceSchema.optional(),
  /**
   * The answering CLI's own update state from its cached daily check (`happier self check`),
   * filtered to its release channel. Never a network read; `null` when no check has cached a
   * result yet, absent from older CLIs. The K5 facts (`CliUpdateFactsSchema`: channel, install
   * source, update command, remote-update support, last outcome) extend it and are absent from
   * CLIs that predate them.
   */
  cliUpdate: z.object({
    currentVersion: NonEmptyString,
    latestVersion: NonEmptyString.nullable(),
    updateAvailable: z.boolean(),
  }).extend(CliUpdateFactsSchema.omit({ currentVersion: true, latestVersion: true }).partial().shape).nullable().optional(),
}));

export type DoctorSnapshotDaemonStatus = z.infer<typeof DoctorSnapshotDaemonStatusSchema>;

export const HappierDoctorActiveInvocationSchema = lazySchema(() => z.object({
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  invokerName: NonEmptyString.nullable(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  installationId: NonEmptyString.nullable(),
}));

export const HappierDoctorInstallationSchema = lazySchema(() => z.object({
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

export const HappierDoctorInstallationInventorySchema = lazySchema(() => z.object({
  activeInvocation: HappierDoctorActiveInvocationSchema.nullable(),
  installations: z.array(HappierDoctorInstallationSchema),
}));

export const HappierDoctorServiceSchema = lazySchema(() => z.object({
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
  configuredCliVersion: NonEmptyString.nullable().optional(),
  runningCliVersion: NonEmptyString.nullable().optional(),
}));

export const HappierDoctorServiceInventorySchema = lazySchema(() => z.object({
  services: z.array(HappierDoctorServiceSchema),
}));

export const HappierDoctorRelaySchema = lazySchema(() => z.object({
  id: NonEmptyString,
  ring: PublicReleaseChannelLabelSchema,
  scope: z.enum(['user', 'system']),
  installed: z.boolean(),
  version: NonEmptyString.nullable(),
  relayUrl: NonEmptyString,
  healthy: z.boolean().nullable(),
  serviceActive: z.boolean().nullable(),
  serviceEnabled: z.boolean().nullable(),
  warnings: z.array(NonEmptyString).optional(),
}));

export const HappierDoctorRelayInventorySchema = lazySchema(() => z.object({
  relays: z.array(HappierDoctorRelaySchema),
}));

export const HappierDoctorWarningSchema = lazySchema(() => z.object({
  code: NonEmptyString,
  severity: HappierWarningSeveritySchema,
  message: NonEmptyString,
  repairCommands: z.array(NonEmptyString),
}));

export const DoctorSnapshotSchema = lazySchema(() => z.object({
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
  relays: z.object({
    happier: HappierDoctorRelayInventorySchema.optional(),
  }).optional(),
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
    installations: snapshot.installations
      ? {
          ...snapshot.installations,
          happier: snapshot.installations.happier
            ? {
                ...snapshot.installations.happier,
                activeInvocation: snapshot.installations.happier.activeInvocation
                  ? {
                      ...snapshot.installations.happier.activeInvocation,
                      path: sanitizeUrl(snapshot.installations.happier.activeInvocation.path),
                      realPath: snapshot.installations.happier.activeInvocation.realPath
                        ? sanitizeUrl(snapshot.installations.happier.activeInvocation.realPath)
                        : null,
                    }
                  : null,
                installations: snapshot.installations.happier.installations.map((entry) => ({
                  ...entry,
                  path: sanitizeUrl(entry.path),
                  realPath: entry.realPath ? sanitizeUrl(entry.realPath) : null,
                })),
              }
            : undefined,
        }
      : undefined,
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
    relays: snapshot.relays
      ? {
          ...snapshot.relays,
          happier: snapshot.relays.happier
            ? {
                ...snapshot.relays.happier,
                relays: snapshot.relays.happier.relays.map((entry) => ({
                  ...entry,
                  relayUrl: sanitizeUrl(entry.relayUrl),
                  warnings: entry.warnings?.map((warning) => sanitizeUrl(warning)),
                })),
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
