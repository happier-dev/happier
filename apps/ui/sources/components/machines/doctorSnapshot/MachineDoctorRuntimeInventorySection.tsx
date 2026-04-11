import * as React from 'react';

import type {
    DoctorSnapshot,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { describeBackgroundServiceTargetMode } from '@/components/systemTasks/describeBackgroundServiceTargetMode';

import type { MachineDoctorSnapshotState } from './useMachineDoctorSnapshot';

export type MachineDoctorRuntimeInventorySectionProps = Readonly<{
    snapshotState: MachineDoctorSnapshotState | null | undefined;
    mode?: 'summary' | 'details';
}>;

type RuntimeInstallationViewModel = Readonly<{
    installation: HappierDoctorInstallation;
    detail: string;
    subtitle: string;
}>;

type RuntimeServiceViewModel = Readonly<{
    service: HappierDoctorService;
    detail: string;
    subtitle: string;
}>;

type HappierDoctorInstallationInventory = NonNullable<NonNullable<DoctorSnapshot['installations']>['happier']>;
type HappierDoctorServiceInventory = NonNullable<NonNullable<DoctorSnapshot['services']>['happier']>;
type HappierDoctorInstallation = HappierDoctorInstallationInventory['installations'][number];
type HappierDoctorService = HappierDoctorServiceInventory['services'][number];
type HappierDoctorWarning = NonNullable<DoctorSnapshot['warnings']>[number];

function normalizePath(raw: string | null | undefined): string {
    return String(raw ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

function normalizeComparisonPath(raw: string | null | undefined, caseInsensitive: boolean): string {
    const normalized = normalizePath(raw);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isPathWithinCandidateRoot(path: string, candidateRoot: string): boolean {
    if (!candidateRoot) return false;
    if (path === candidateRoot) return true;
    return path.startsWith(`${candidateRoot}/`);
}

function formatRingLabel(ring: string | null | undefined): string {
    return ring ? String(ring) : t('status.unknown');
}

function resolveInstallationTitle(installation: HappierDoctorInstallation): string {
    return installation.shimName ?? installation.id;
}

function resolveInstallationSubtitle(installation: HappierDoctorInstallation): string {
    const parts = [
        installation.source,
        formatRingLabel(installation.ring),
        normalizePath(installation.path),
    ].filter((part) => part && part !== t('status.unknown'));

    return parts.length > 0 ? parts.join(' • ') : t('status.unknown');
}

function findMatchedInstallationVersion(service: HappierDoctorService, installations: readonly HappierDoctorInstallation[]): string | null {
    const caseInsensitive = service.platform === 'win32';
    const executablePath = normalizeComparisonPath(service.executablePath, caseInsensitive);
    if (!executablePath) return null;

    for (const installation of installations) {
        const candidates = [installation.path, installation.realPath]
            .map((candidate) => normalizeComparisonPath(candidate, caseInsensitive))
            .filter(Boolean);
        if (candidates.some((candidate) => isPathWithinCandidateRoot(executablePath, candidate))) {
            return installation.version ?? null;
        }
    }

    return null;
}

function resolveServiceTitle(service: HappierDoctorService): string {
    const parts = [service.label];
    if (service.instanceId) {
        parts.push(service.instanceId);
    }
    return parts.join(' • ');
}

function resolveServiceSubtitle(service: HappierDoctorService): string {
    const parts = [
        service.backend,
        service.scope,
        service.targetMode ? describeBackgroundServiceTargetMode(service.targetMode) : null,
        service.ring ?? null,
        service.publicServerUrl ?? service.serverUrl ?? null,
        normalizePath(service.executablePath),
    ].filter((part) => part && part !== t('status.unknown'));

    return parts.length > 0 ? parts.join(' • ') : t('status.unknown');
}

function resolveWarningSubtitle(warning: HappierDoctorWarning): string {
    return warning.message;
}

function joinSubtitleLines(parts: ReadonlyArray<string | null | undefined>): string {
    const lines = parts
        .map((part) => String(part ?? '').trim())
        .filter((part) => part.length > 0);

    return lines.length > 0 ? lines.join('\n') : t('status.unknown');
}

function renderStatusItem(state: MachineDoctorSnapshotState): React.ReactNode {
    if (state.status === 'loading') {
        return (
            <Item
                testID="machine-runtime-inventory-status"
                title={t('common.loading')}
                subtitle={t('systemStatus.machine.fetchDoctorSnapshot.loading')}
                showChevron={false}
                mode="info"
            />
        );
    }

    if (state.status === 'error') {
        return (
            <Item
                testID="machine-runtime-inventory-status"
                title={t('common.error')}
                subtitle={state.detail}
                showChevron={false}
                mode="info"
            />
        );
    }

    return (
        <Item
            testID="machine-runtime-inventory-status"
            title={t('status.unknown')}
            subtitle={t('status.unknown')}
            showChevron={false}
            mode="info"
        />
    );
}

function renderRuntimeSummary(snapshot: DoctorSnapshot): React.ReactNode {
    const happierInstallations = snapshot.installations?.happier;
    const happierServices = snapshot.services?.happier;
    const activeInvocation = happierInstallations?.activeInvocation ?? null;
    const daemon = snapshot.daemonStatus?.daemon ?? null;
    const installations = happierInstallations?.installations ?? [];
    const services = happierServices?.services ?? [];
    const warnings = snapshot.warnings ?? [];
    const otherInstallations = activeInvocation?.installationId
        ? installations.filter((installation) => installation.id !== activeInvocation.installationId)
        : installations;

    return (
        <Item
            testID="machine-runtime-inventory-summary"
            title={t('machine.runtimeInventoryOverview')}
            subtitle={t('machine.runtimeSummary', {
                cliVersion: activeInvocation?.version ?? t('status.unknown'),
                daemonVersion: daemon?.startedWithCliVersion ?? t('status.unknown'),
                daemonRing: daemon?.startedWithPublicReleaseChannel ?? t('status.unknown'),
                installationCount: otherInstallations.length,
                serviceCount: services.length,
                warningCount: warnings.length,
            })}
            detail={activeInvocation?.version ?? t('status.unknown')}
            subtitleLines={0}
            showChevron={false}
            mode="info"
        />
    );
}

function renderRuntimeWarnings(warnings: readonly HappierDoctorWarning[]): React.ReactNode[] {
    return warnings.map((warning, index) => (
        <Item
            key={`${warning.code}:${index}`}
            title={warning.code}
            detail={warning.severity}
            subtitle={resolveWarningSubtitle(warning)}
            subtitleLines={0}
            showChevron={false}
            mode="info"
            copy={warning.repairCommands[0] ?? false}
        />
    ));
}

export const MachineDoctorRuntimeInventorySection = React.memo(function MachineDoctorRuntimeInventorySection(props: MachineDoctorRuntimeInventorySectionProps) {
    const snapshotState = props.snapshotState ?? { status: 'idle' };

    if (snapshotState.status !== 'ready') {
        if (props.mode === 'summary') {
            return renderStatusItem(snapshotState);
        }
        return (
            <ItemGroup title={t('machine.runtimeInventory')}>
                {renderStatusItem(snapshotState)}
            </ItemGroup>
        );
    }

    const snapshot = snapshotState.snapshot;
    const happierInstallations = snapshot.installations?.happier;
    const happierServices = snapshot.services?.happier;
    const activeInvocation = happierInstallations?.activeInvocation ?? null;
    const daemon = snapshot.daemonStatus?.daemon ?? null;
    const installations = happierInstallations?.installations ?? [];
    const services = happierServices?.services ?? [];
    const warnings = snapshot.warnings ?? [];
    const otherInstallations = activeInvocation?.installationId
        ? installations.filter((installation) => installation.id !== activeInvocation.installationId)
        : installations;

    const installationRows: RuntimeInstallationViewModel[] = otherInstallations.map((installation) => ({
        installation,
        detail: installation.version ?? t('status.unknown'),
        subtitle: resolveInstallationSubtitle(installation),
    }));

    const serviceRows: RuntimeServiceViewModel[] = services.map((service) => ({
        service,
        detail: findMatchedInstallationVersion(service, installations) ?? t('status.unknown'),
        subtitle: resolveServiceSubtitle(service),
    }));

    const warningItems = renderRuntimeWarnings(warnings);

    if (props.mode === 'summary') {
        return (
            <>
                {renderRuntimeSummary(snapshot)}
                {warningItems}
            </>
        );
    }

    return (
        <>
            <ItemGroup title={t('machine.runtimeInventory')}>
                <Item
                    testID="machine-runtime-inventory-cli"
                    title={t('machine.cliVersion')}
                    detail={activeInvocation?.version ?? t('status.unknown')}
                    subtitle={joinSubtitleLines([
                        activeInvocation?.ring ?? t('status.unknown'),
                        normalizePath(activeInvocation?.path) || t('status.unknown'),
                    ])}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="machine-runtime-inventory-daemon"
                    title={t('machine.daemon')}
                    detail={daemon?.startedWithCliVersion ?? t('status.unknown')}
                    subtitle={joinSubtitleLines([
                        daemon?.startedWithPublicReleaseChannel ?? t('status.unknown'),
                        snapshot.daemonStatus?.server.localServerUrl ?? snapshot.daemonStatus?.server.serverUrl ?? t('status.unknown'),
                    ])}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
                {renderRuntimeSummary(snapshot)}
            </ItemGroup>

            {props.mode === 'details' && installationRows.length > 0 ? (
                <ItemGroup title={t('machine.runtimeInventoryInstallations')}>
                    {installationRows.map(({ installation, detail, subtitle }) => (
                        <Item
                            key={installation.id}
                            title={resolveInstallationTitle(installation)}
                            detail={detail}
                            subtitle={subtitle}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                            copy={normalizePath(installation.path) || installation.id}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {props.mode === 'details' && serviceRows.length > 0 ? (
                <ItemGroup title={t('machine.runtimeInventoryServices')}>
                    {serviceRows.map(({ service, detail, subtitle }) => (
                        <Item
                            key={service.id}
                            title={resolveServiceTitle(service)}
                            detail={detail}
                            subtitle={subtitle}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                            copy={normalizePath(service.definitionPath)}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {warnings.length > 0 ? (
                <ItemGroup title={t('machine.runtimeInventoryWarnings')}>
                    {warningItems}
                </ItemGroup>
            ) : null}
        </>
    );
});
