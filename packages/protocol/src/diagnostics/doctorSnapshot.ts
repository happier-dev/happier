import { z } from 'zod';

import { sanitizeBugReportUrl } from '../bugReports/sanitize.js';

const NonEmptyString = z.string().trim().min(1);

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
