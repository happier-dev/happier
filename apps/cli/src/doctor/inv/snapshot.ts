import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import type { DoctorRepairReport } from '@/diagnostics/doctorRepair/types';

import {
  DoctorSnapshotSchema,
  sanitizeDoctorSnapshotUrls,
  type DoctorSnapshot as ProtocolDoctorSnapshot,
} from '@happier-dev/protocol';

import type { DoctorRuntimeInventory } from './runtime';

export type DoctorSnapshot = ProtocolDoctorSnapshot;
type HappierInstallations = NonNullable<NonNullable<DoctorSnapshot['installations']>['happier']>;
type HappierServices = NonNullable<NonNullable<DoctorSnapshot['services']>['happier']>;
type HappierWarnings = NonNullable<DoctorSnapshot['warnings']>;
type PublicReleaseChannelLabel = 'stable' | 'preview' | 'dev';

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function normalizePublicReleaseChannel(raw: string | null | undefined): PublicReleaseChannelLabel | null {
  const value = String(raw ?? '').trim();
  if (value === 'stable' || value === 'preview' || value === 'dev') {
    return value;
  }
  if (value === 'publicdev') {
    return 'dev';
  }
  return null;
}

function buildRepairSummaryFromReport(report: DoctorRepairReport): NonNullable<DoctorSnapshot['repairSummary']> {
  const counts = {
    total: report.findings.length,
    info: report.findings.filter((finding) => finding.severity === 'info').length,
    warning: report.findings.filter((finding) => finding.severity === 'warning').length,
    error: 0,
    actionable: report.findings.filter((finding) => 'actions' in finding && Array.isArray(finding.actions) && finding.actions.length > 0).length,
  };
  return {
    schemaVersion: 2,
    status: counts.error > 0 || counts.warning > 0 ? 'needs_attention' : 'ok',
    findingCounts: counts,
    findingKinds: report.findings.map((finding) => finding.kind),
  };
}

function buildFallbackRepairSummary(warnings: ReadonlyArray<HappierWarnings[number]>): NonNullable<DoctorSnapshot['repairSummary']> {
  const counts = {
    total: warnings.length,
    info: warnings.filter((warning) => warning.severity === 'info').length,
    warning: warnings.filter((warning) => warning.severity === 'warning').length,
    error: warnings.filter((warning) => warning.severity === 'error').length,
    actionable: warnings.filter((warning) => warning.repairCommands.length > 0).length,
  };
  return {
    schemaVersion: 1,
    status: counts.error > 0 || counts.warning > 0 ? 'needs_attention' : 'ok',
    findingCounts: counts,
    findingKinds: warnings.map((warning) => warning.code),
  };
}

function buildAutomaticStartupSummaryFromReport(report: DoctorRepairReport): NonNullable<DoctorSnapshot['automaticStartup']> {
  const entries = report.automaticStartup.map((entry) => ({
    id: entry.name,
    label: entry.name,
    releaseChannel: normalizePublicReleaseChannel(entry.releaseChannel),
    targetMode: entry.targetMode,
    scope: entry.mode ?? 'user',
    installed: true,
    running: entry.running,
    definitionPath: entry.path,
    relayUrl: entry.relayUrl,
  }));
  return {
    entries,
    defaultFollowingCount: entries.filter((entry) => entry.targetMode === 'default-following').length,
    pinnedCount: entries.filter((entry) => entry.targetMode === 'pinned').length,
  };
}

function buildFallbackAutomaticStartupSummary(services: HappierServices): NonNullable<DoctorSnapshot['automaticStartup']> {
  const entries = services.services
    .filter((service) => service.serviceType === 'daemon')
    .map((service) => ({
      id: service.id,
      label: service.label,
      releaseChannel: normalizePublicReleaseChannel(service.ring),
      targetMode: service.targetMode,
      scope: service.scope,
      installed: service.installed,
      running: service.running,
      definitionPath: service.definitionPath,
      relayUrl: service.publicServerUrl ?? service.serverUrl ?? null,
    }));
  return {
    entries,
    defaultFollowingCount: entries.filter((entry) => entry.targetMode === 'default-following').length,
    pinnedCount: entries.filter((entry) => entry.targetMode === 'pinned').length,
  };
}

function buildLocalRelayInventoryFromReport(report: DoctorRepairReport): NonNullable<DoctorSnapshot['localRelays']> {
  return {
    relays: report.localRelays.flatMap((relay) => {
      const releaseChannel = normalizePublicReleaseChannel(relay.releaseChannel);
      if (!releaseChannel) return [];
      return [{
        id: `${releaseChannel}:${relay.mode}`,
        releaseChannel,
        relayUrl: relay.relayUrl,
        version: relay.version ?? null,
        installed: true,
        running: relay.serviceActive,
        healthy: relay.healthy === true,
        serviceEnabled: relay.serviceEnabled,
        port: relay.port,
        installRoot: relay.installRoot,
      }];
    }),
  };
}

function buildActiveStackSummary(params: Readonly<{
  activeServerId: string;
  serverUrl: string;
  publicServerUrl: string;
  daemonStatus: DoctorSnapshot['daemonStatus'] | undefined;
  installations: HappierInstallations;
  report: DoctorRepairReport | null;
}>): NonNullable<DoctorSnapshot['activeStack']> {
  const daemonServer = params.daemonStatus?.server;
  const resolvedServerUrl = daemonServer?.serverUrl ?? params.serverUrl;
  const resolvedPublicServerUrl = daemonServer?.publicServerUrl ?? params.publicServerUrl;
  const resolvedActiveServerId = daemonServer?.activeServerId ?? params.activeServerId;
  return {
    activeServerId: resolvedActiveServerId,
    releaseChannel: normalizePublicReleaseChannel(params.report?.currentCli.releaseChannel ?? params.installations.activeInvocation?.ring),
    relayUrl: resolvedServerUrl,
    publicRelayUrl: resolvedPublicServerUrl,
    localRelayUrl: resolvedServerUrl.startsWith('http://127.0.0.1')
      || resolvedServerUrl.startsWith('http://localhost')
      ? resolvedServerUrl
      : null,
    source: params.report ? 'doctor-repair-report' : daemonServer ? 'daemon-status' : 'configuration',
  };
}

function buildServiceHealth(params: Readonly<{
  daemonStatus: DoctorSnapshot['daemonStatus'] | undefined;
  report: DoctorRepairReport | null;
}>): NonNullable<DoctorSnapshot['serviceHealth']> {
  const activeEntry = params.report?.automaticStartup.find((entry) => entry.running === true)
    ?? params.report?.automaticStartup[0]
    ?? null;
  if (activeEntry) {
    return {
      backgroundService: {
        installed: true,
        running: activeEntry.running === true,
        healthy: activeEntry.running === true,
        serviceLabel: activeEntry.name,
        releaseChannel: normalizePublicReleaseChannel(activeEntry.releaseChannel),
        relayUrl: activeEntry.relayUrl ?? null,
      },
    };
  }

  const service = params.daemonStatus?.service;
  const daemon = params.daemonStatus?.daemon;
  const auth = params.daemonStatus?.auth;
  const server = params.daemonStatus?.server;
  if (!service) {
    return {};
  }
  return {
    backgroundService: {
      installed: service.installed,
      running: service.running,
      healthy: service.installed && service.running && auth?.needsAuth !== true,
      serviceLabel: daemon?.serviceLabel ?? null,
      releaseChannel: normalizePublicReleaseChannel(daemon?.startedWithPublicReleaseChannel),
      relayUrl: server?.publicServerUrl ?? server?.serverUrl ?? null,
    },
  };
}

export function buildDoctorSnapshotFromInventory(params: Readonly<{
  inventory: DoctorRuntimeInventory;
  doctorRepairReport?: DoctorRepairReport | null;
}>): DoctorSnapshot {
  const doctorRepairReport = params.doctorRepairReport ?? null;
  const { credentials, daemonStatus, installations, localRelays, services, settings, warnings } = params.inventory;

  const token = credentials?.token ?? '';
  const payload = token ? decodeJwtPayload(token) : null;
  const sub = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const accountId = sub || null;

  const knownAccountIds: string[] = [];
  const cursorMapByServer = settings.lastChangesCursorByServerIdByAccountId ?? {};
  for (const byAccountId of Object.values(cursorMapByServer)) {
    if (!byAccountId || typeof byAccountId !== 'object') continue;
    for (const knownAccountId of Object.keys(byAccountId)) {
      const normalized = String(knownAccountId ?? '').trim();
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
    installations: {
      happier: installations,
    },
    services: {
      happier: services,
    },
    repairSummary: doctorRepairReport ? buildRepairSummaryFromReport(doctorRepairReport) : buildFallbackRepairSummary(warnings),
    localRelays: doctorRepairReport ? buildLocalRelayInventoryFromReport(doctorRepairReport) : localRelays,
    automaticStartup: doctorRepairReport ? buildAutomaticStartupSummaryFromReport(doctorRepairReport) : buildFallbackAutomaticStartupSummary(services),
    activeStack: buildActiveStackSummary({
      activeServerId: configuration.activeServerId,
      serverUrl: configuration.serverUrl,
      publicServerUrl: configuration.publicServerUrl,
      daemonStatus,
      installations,
      report: doctorRepairReport,
    }),
    serviceHealth: buildServiceHealth({ daemonStatus, report: doctorRepairReport }),
    warnings: [...warnings],
    ...(daemonStatus ? { daemonStatus } : {}),
  };

  const parsed = DoctorSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    return sanitizeDoctorSnapshotUrls({
      capturedAt: candidate.capturedAt,
      server: candidate.server,
      accountId: candidate.accountId,
      settings: {
        activeServerId: candidate.settings.activeServerId,
        servers: [],
        knownAccountIds: candidate.settings.knownAccountIds,
      },
      installations: candidate.installations,
      services: candidate.services,
      repairSummary: candidate.repairSummary,
      localRelays: candidate.localRelays,
      automaticStartup: candidate.automaticStartup,
      activeStack: candidate.activeStack,
      serviceHealth: candidate.serviceHealth,
      warnings: candidate.warnings,
      ...(candidate.daemonStatus ? { daemonStatus: candidate.daemonStatus } : {}),
    });
  }

  return sanitizeDoctorSnapshotUrls(parsed.data);
}
