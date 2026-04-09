import {
  bullets,
  cmd,
  definitionList,
  sectionTitle,
  warn,
} from '@happier-dev/cli-common/output';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';

import type { DoctorSnapshot } from './doctorSnapshot';

type HappierDoctorInstallationInventory = NonNullable<NonNullable<DoctorSnapshot['installations']>['happier']>;
type HappierDoctorServiceInventory = NonNullable<NonNullable<DoctorSnapshot['services']>['happier']>;
type HappierDoctorInstallation = HappierDoctorInstallationInventory['installations'][number];
type HappierDoctorService = HappierDoctorServiceInventory['services'][number];
type HappierDoctorWarning = NonNullable<DoctorSnapshot['warnings']>[number];

function formatUnknown(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  return normalized || '(unknown)';
}

function formatActiveInvocationSummary(snapshot: DoctorSnapshot): string {
  const activeInvocation = snapshot.installations?.happier?.activeInvocation ?? null;
  const daemon = snapshot.daemonStatus?.daemon ?? null;
  const installations = snapshot.installations?.happier?.installations ?? [];
  const services = snapshot.services?.happier?.services ?? [];
  const warnings = snapshot.warnings ?? [];

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
        formatUnknown(snapshot.daemonStatus?.server.localServerUrl ?? snapshot.daemonStatus?.server.serverUrl),
      ].join(' • '),
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
    service.publicServerUrl ?? service.serverUrl ?? null,
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

export function renderDoctorHappierRuntimeInventory(snapshot: DoctorSnapshot): string {
  const activeInstallationId = snapshot.installations?.happier?.activeInvocation?.installationId ?? null;
  const installations = snapshot.installations?.happier?.installations ?? [];
  const services = snapshot.services?.happier?.services ?? [];
  const warnings = snapshot.warnings ?? [];

  const sections: string[] = [
    sectionTitle('Happier runtime'),
    formatActiveInvocationSummary(snapshot),
  ];

  if (installations.length > 0) {
    sections.push(sectionTitle('Detected installations'));
    sections.push(bullets(installations.map((installation) => formatInstallationLine(installation, activeInstallationId))));
  }

  if (services.length > 0) {
    sections.push(sectionTitle('Detected services'));
    sections.push(bullets(services.map((service) => formatServiceLine(service))));
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
