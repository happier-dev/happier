import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readCredentials, readSettings } from '@/persistence';

import {
  DoctorSnapshotSchema,
  sanitizeDoctorSnapshotUrls,
  type DoctorSnapshot as ProtocolDoctorSnapshot,
} from '@happier-dev/protocol';

export type DoctorSnapshot = ProtocolDoctorSnapshot;

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

export async function buildDoctorSnapshot(): Promise<DoctorSnapshot> {
  const [settings, credentials] = await Promise.all([readSettings(), readCredentials()]);

  const token = credentials?.token ?? '';
  const payload = token ? decodeJwtPayload(token) : null;
  const sub = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const accountId = sub || null;

  const knownAccountIds: string[] = [];
  const cursorMapByServer = settings.lastChangesCursorByServerIdByAccountId ?? {};
  for (const byAccountId of Object.values(cursorMapByServer)) {
    if (!byAccountId || typeof byAccountId !== 'object') continue;
    for (const accountId of Object.keys(byAccountId)) {
      const normalized = String(accountId ?? '').trim();
      if (normalized) knownAccountIds.push(normalized);
    }
  }
  if (accountId) knownAccountIds.push(accountId);

  const servers = Object.values(settings.servers ?? {})
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id ?? '').trim(),
      name: String(entry.name ?? '').trim(),
      serverUrl: String(entry.serverUrl ?? '').trim(),
      webappUrl: String(entry.webappUrl ?? '').trim(),
      createdAt: Number(entry.createdAt ?? 0) || 0,
      updatedAt: Number(entry.updatedAt ?? 0) || 0,
      lastUsedAt: Number(entry.lastUsedAt ?? 0) || 0,
    }))
    .filter((entry) => entry.id && entry.name && entry.serverUrl && entry.webappUrl)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  const candidate: DoctorSnapshot = {
    capturedAt: new Date().toISOString(),
    server: {
      activeServerId: configuration.activeServerId,
      serverUrl: configuration.serverUrl,
      publicServerUrl: configuration.publicServerUrl,
      webappUrl: configuration.webappUrl,
    },
    accountId,
    settings: {
      activeServerId: settings.activeServerId ? String(settings.activeServerId).trim() : null,
      servers,
      knownAccountIds: uniqueSorted(knownAccountIds),
    },
  };

  const parsed = DoctorSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    // Defensive: should never happen, but fail closed to a minimal safe payload.
    return sanitizeDoctorSnapshotUrls({
      capturedAt: candidate.capturedAt,
      server: candidate.server,
      accountId: candidate.accountId,
      settings: {
        activeServerId: candidate.settings.activeServerId,
        servers: [],
        knownAccountIds: candidate.settings.knownAccountIds,
      },
    });
  }

  return sanitizeDoctorSnapshotUrls(parsed.data);
}
