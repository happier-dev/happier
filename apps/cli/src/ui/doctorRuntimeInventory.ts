import {
  bullets,
  cmd,
  definitionList,
  sectionTitle,
  warn,
} from '@happier-dev/cli-common/output';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';

import type { DoctorSnapshot } from './doctorSnapshot';
import { redactDoctorDiagnosticText } from './doctorRedaction';

type HappierDoctorInstallationInventory = NonNullable<NonNullable<DoctorSnapshot['installations']>['happier']>;
type HappierDoctorServiceInventory = NonNullable<NonNullable<DoctorSnapshot['services']>['happier']>;
type HappierDoctorInstallation = HappierDoctorInstallationInventory['installations'][number];
type HappierDoctorService = HappierDoctorServiceInventory['services'][number];
type HappierDoctorWarning = NonNullable<DoctorSnapshot['warnings']>[number];
type DoctorSnapshotLocalRelay = NonNullable<DoctorSnapshot['localRelays']>['relays'][number];
type DoctorSnapshotAutomaticStartupEntry = NonNullable<DoctorSnapshot['automaticStartup']>['entries'][number];

function formatUnknown(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  return normalized || '(unknown)';
}

function formatDoctorUrl(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '(unknown)';
  return redactDoctorDiagnosticText(normalized);
}

function formatOwnerLabel(snapshot: DoctorSnapshot): string {
  const daemon = snapshot.daemonStatus?.daemon ?? null;
  if (!daemon) {
    return '(none)';
  }
  const parts = [
    daemon.serviceManaged === true
      ? 'background service'
      : daemon.serviceManaged === false
        ? 'manual relay runtime'
        : 'relay owner',
    daemon.serviceLabel ?? null,
    daemon.startedWithPublicReleaseChannel ?? null,
    daemon.startedWithCliVersion ?? null,
  ].filter(Boolean);
  return parts.join(' • ') || '(unknown)';
}

function hasCurrentInvocationOwnerMismatch(snapshot: DoctorSnapshot): boolean {
  const activeInvocation = snapshot.installations?.happier?.activeInvocation ?? null;
  const daemon = snapshot.daemonStatus?.daemon ?? null;
  if (!activeInvocation || !daemon) {
    return false;
  }
  const versionMismatch = Boolean(
    activeInvocation.version
      && daemon.startedWithCliVersion
      && activeInvocation.version !== daemon.startedWithCliVersion,
  );
  const releaseChannelMismatch = Boolean(
    activeInvocation.ring
      && daemon.startedWithPublicReleaseChannel
      && activeInvocation.ring !== daemon.startedWithPublicReleaseChannel,
  );
  return versionMismatch || releaseChannelMismatch;
}

function formatActiveInvocationSummary(snapshot: DoctorSnapshot): string {
  const activeInvocation = snapshot.installations?.happier?.activeInvocation ?? null;
  const daemon = snapshot.daemonStatus?.daemon ?? null;
  const installations: readonly HappierDoctorInstallation[] = snapshot.installations?.happier?.installations ?? [];
  const services: readonly HappierDoctorService[] = snapshot.services?.happier?.services ?? [];
  const warnings: readonly HappierDoctorWarning[] = snapshot.warnings ?? [];

  return definitionList([
    {
      label: 'Invoked CLI',
      value: [
        formatUnknown(activeInvocation?.version),
        formatUnknown(activeInvocation?.ring),
        formatUnknown(activeInvocation?.path),
      ].join(' • '),
    },
    {
      label: 'Running daemon',
      value: [
        formatUnknown(daemon?.startedWithCliVersion),
        formatUnknown(daemon?.startedWithPublicReleaseChannel),
        formatDoctorUrl(snapshot.daemonStatus?.server.localServerUrl ?? snapshot.daemonStatus?.server.serverUrl),
      ].join(' • '),
    },
    {
      label: 'Current owner',
      value: formatOwnerLabel(snapshot),
    },
    {
      label: 'Detected installations',
      value: String(installations.length),
    },
    {
      label: 'Detected services',
      value: String(services.length),
    },
    {
      label: 'Warnings',
      value: String(warnings.length),
    },
  ]);
}

function formatInstallationLine(
  installation: HappierDoctorInstallation,
  activeInstallationId: string | null,
): string {
  const parts = [
    installation.shimName ?? installation.id,
    installation.version ?? null,
    installation.ring ?? null,
    installation.path,
  ].filter(Boolean);
  const prefix = installation.id === activeInstallationId ? '(active) ' : '';
  return `${prefix}${parts.join(' • ')}`;
}

function formatServiceLine(service: HappierDoctorService): string {
    const serviceTypeLabel =
    service.serviceType === 'daemon'
      ? 'Background service'
      : service.serviceType === 'stack-service'
        ? 'Stack service'
        : service.serviceType === 'self-host-service'
          ? 'Self-host service'
          : service.serviceType;
  const parts = [
    serviceTypeLabel,
    service.label,
    service.backend,
    service.targetMode ? describeBackgroundServiceTargetMode(service.targetMode) : null,
    service.ring ?? null,
    service.instanceId ?? null,
    service.publicServerUrl || service.serverUrl ? formatDoctorUrl(service.publicServerUrl ?? service.serverUrl ?? null) : null,
    service.definitionPath,
  ].filter(Boolean);
  return parts.join(' • ');
}

function formatWarningLines(warningEntry: HappierDoctorWarning): string[] {
  const lines = [
    `${warningEntry.code} • ${warningEntry.severity}`,
    warningEntry.message,
  ];
  for (const repairCommand of warningEntry.repairCommands ?? []) {
    const normalized = String(repairCommand ?? '').trim();
    if (!normalized) continue;
    lines.push(`Run: ${cmd(normalized)}`);
  }
  return lines;
}

function formatFindingCounts(snapshot: DoctorSnapshot): string {
  const counts = snapshot.repairSummary?.findingCounts;
  if (!counts) return '(unknown)';
  const parts = [
    `total ${counts.total}`,
    counts.info !== undefined ? `info ${counts.info}` : null,
    counts.warning !== undefined ? `warning ${counts.warning}` : null,
    counts.error !== undefined ? `error ${counts.error}` : null,
    counts.actionable !== undefined ? `actionable ${counts.actionable}` : null,
  ].filter(Boolean);
  return parts.join(' • ');
}

function formatLocalRelayLine(relay: DoctorSnapshotLocalRelay): string {
  return [
    relay.id,
    relay.releaseChannel,
    relay.version ?? null,
    relay.relayUrl ? formatDoctorUrl(relay.relayUrl) : null,
    relay.healthy === true ? 'healthy' : relay.healthy === false ? 'needs attention' : null,
    relay.running === true ? 'running' : relay.running === false ? 'stopped' : null,
  ].filter(Boolean).join(' • ');
}

function formatAutomaticStartupLine(entry: DoctorSnapshotAutomaticStartupEntry): string {
  return [
    entry.label,
    entry.releaseChannel ?? null,
    entry.targetMode ? describeBackgroundServiceTargetMode(entry.targetMode) : null,
    entry.running === true ? 'running' : entry.running === false ? 'stopped' : null,
    entry.relayUrl ? formatDoctorUrl(entry.relayUrl) : null,
  ].filter(Boolean).join(' • ');
}

function renderDoctorSnapshotDiagnostics(snapshot: DoctorSnapshot): string {
  const sections: string[] = [];

  if (snapshot.repairSummary || snapshot.activeStack || snapshot.serviceHealth) {
    sections.push(sectionTitle('Doctor snapshot diagnostics'));
    sections.push(definitionList([
      {
        label: 'Repair status',
        value: formatUnknown(snapshot.repairSummary?.status),
      },
      {
        label: 'Findings',
        value: formatFindingCounts(snapshot),
      },
      {
        label: 'Active stack',
        value: [
          formatUnknown(snapshot.activeStack?.activeServerId),
          formatUnknown(snapshot.activeStack?.releaseChannel),
          formatDoctorUrl(snapshot.activeStack?.relayUrl),
          snapshot.activeStack?.localRelayUrl ? formatDoctorUrl(snapshot.activeStack.localRelayUrl) : null,
        ].filter(Boolean).join(' • '),
      },
      {
        label: 'Background service health',
        value: [
          snapshot.serviceHealth?.backgroundService?.healthy === true
            ? 'healthy'
            : snapshot.serviceHealth?.backgroundService?.healthy === false
              ? 'needs attention'
              : '(unknown)',
          snapshot.serviceHealth?.backgroundService?.serviceLabel ?? null,
          snapshot.serviceHealth?.backgroundService?.releaseChannel ?? null,
        ].filter(Boolean).join(' • '),
      },
    ]));
  }

  const localRelays = snapshot.localRelays?.relays ?? [];
  if (localRelays.length > 0) {
    sections.push(sectionTitle('Local relays'));
    sections.push(bullets(localRelays.map(formatLocalRelayLine)));
  }

  const automaticStartupEntries = snapshot.automaticStartup?.entries ?? [];
  if (automaticStartupEntries.length > 0) {
    sections.push(sectionTitle('Automatic startup'));
    sections.push(bullets(automaticStartupEntries.map(formatAutomaticStartupLine)));
  }

  return sections.filter(Boolean).join('\n');
}

export function renderDoctorHappierRuntimeInventory(snapshot: DoctorSnapshot): string {
  const activeInstallationId = snapshot.installations?.happier?.activeInvocation?.installationId ?? null;
  const installations: readonly HappierDoctorInstallation[] = snapshot.installations?.happier?.installations ?? [];
  const services: readonly HappierDoctorService[] = snapshot.services?.happier?.services ?? [];
  const warnings: readonly HappierDoctorWarning[] = snapshot.warnings ?? [];

  const sections: string[] = [
    sectionTitle('Happier runtime'),
    formatActiveInvocationSummary(snapshot),
  ];

  if (hasCurrentInvocationOwnerMismatch(snapshot)) {
    const daemon = snapshot.daemonStatus?.daemon ?? null;
    const restartCommand = daemon?.serviceManaged === true
      ? 'happier service restart'
      : 'happier daemon restart';
    sections.push(warn('Current CLI differs from the running relay owner.'));
    sections.push([
      `  Current owner: ${formatOwnerLabel(snapshot)}`,
      `  Run: ${cmd(restartCommand)}`,
    ].join('\n'));
  }

  if (installations.length > 0) {
    sections.push(sectionTitle('Detected installations'));
    sections.push(bullets(installations.map((installation) => formatInstallationLine(installation, activeInstallationId))));
  }

  if (services.length > 0) {
    sections.push(sectionTitle('Detected services'));
    sections.push(bullets(services.map((service) => formatServiceLine(service))));
  }

  const diagnostics = renderDoctorSnapshotDiagnostics(snapshot);
  if (diagnostics.trim()) {
    sections.push(diagnostics);
  }

  if (warnings.length > 0) {
    sections.push(sectionTitle('Warnings'));
    for (const warningEntry of warnings) {
      const [title, ...details] = formatWarningLines(warningEntry);
      sections.push(warn(title));
      if (details.length > 0) {
        sections.push(details.map((line) => `  ${line}`).join('\n'));
      }
    }
  }

  return sections.filter(Boolean).join('\n');
}
