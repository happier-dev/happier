import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseDoctorSnapshotSafe, type DoctorSnapshot } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useProfile } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { useMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshot';
import { buildDiagnosisReport, type DiagnosisFinding, type DiagnosisReport, type ServerDiagnosticsStatus } from './engine/diagnosisEngine';
import { Icon } from '@/components/ui/icons/Icon';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DIAGNOSIS_SETTINGS } from '@/components/settings/diagnosis/diagnosisSettings';

type MachineRunStatus =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready' }
    | { status: 'error'; detail: string };

function resolveServerDiagnosticsSubtitle(status: ServerDiagnosticsStatus): string | undefined {
    if (status.state !== 'http_error') {
        return undefined;
    }
    return t('diagnosis.serverProbe.httpError', { status: String(status.httpStatus) });
}

function normalizeUrl(raw: string): string {
    const sanitized = sanitizeBugReportUrl(raw) ?? raw;
    return sanitized.replace(/\/+$/, '');
}

function resolveFindingTitle(finding: DiagnosisFinding): string {
    switch (finding.code) {
        case 'server.mismatch.ui_vs_machine':
            return t('diagnosis.findings.serverMismatch.title');
        case 'server.mismatch.ui_vs_pasted':
            return t('diagnosis.findings.serverMismatchPasted.title');
        case 'server.mismatch.settings_vs_resolved':
            return t('diagnosis.findings.settingsMismatch.title');
        case 'auth.mismatch.ui_vs_machine_account':
            return t('diagnosis.findings.accountMismatch.title');
        case 'auth.machine_missing_account':
            return t('diagnosis.findings.machineMissingAccount.title');
        case 'machine.none_online':
            return t('diagnosis.findings.noOnlineMachines.title');
        case 'server.diagnostics_disabled':
            return t('diagnosis.findings.serverDiagnosticsDisabled.title');
        case 'auth.server_401':
            return t('diagnosis.findings.serverAuthError.title');
        case 'server.unreachable':
            return t('diagnosis.findings.serverUnreachable.title');
        case 'server.http_error':
            return t('diagnosis.findings.serverHttpError.title');
        case 'server.profile_missing_for_active_url':
            return t('diagnosis.findings.activeServerNotInProfiles.title');
        case 'server.multiple_machines_multiple_servers':
            return t('diagnosis.findings.multipleServers.title');
        default:
            return finding.code;
    }
}

function resolveFindingSubtitle(finding: DiagnosisFinding): string {
    const details = finding.details ?? {};
    switch (finding.code) {
        case 'server.mismatch.ui_vs_machine':
            return t('diagnosis.findings.serverMismatch.subtitle', {
                ui: String(details.uiServerUrl ?? ''),
                machine: String(details.machineServerUrl ?? ''),
            });
        case 'server.mismatch.ui_vs_pasted':
            return t('diagnosis.findings.serverMismatchPasted.subtitle', {
                ui: String(details.uiServerUrl ?? ''),
                pasted: String(details.pastedServerUrl ?? ''),
            });
        case 'auth.mismatch.ui_vs_machine_account':
            return t('diagnosis.findings.accountMismatch.subtitle', {
                ui: String(details.uiProfileId ?? ''),
                machine: String(details.machineAccountId ?? ''),
            });
        case 'server.mismatch.settings_vs_resolved':
            return t('diagnosis.findings.settingsMismatch.subtitle', {
                settings: String(details.settingsActiveServerId ?? ''),
                resolved: String(details.resolvedServerId ?? ''),
            });
        case 'server.http_error':
            return t('diagnosis.findings.serverHttpError.subtitle', {
                status: String(details.httpStatus ?? details.detail ?? ''),
            });
        default:
            return t('diagnosis.findings.generic.subtitle', {
                code: finding.code,
            });
    }
}

function resolveFindingSteps(finding: DiagnosisFinding): string[] {
    switch (finding.code) {
        case 'server.mismatch.ui_vs_machine':
        case 'server.mismatch.ui_vs_pasted':
            return [
                t('diagnosis.findings.serverMismatch.steps.chooseAccount'),
                t('diagnosis.findings.serverMismatch.steps.switchUiServer'),
                t('diagnosis.findings.serverMismatch.steps.restartDaemon'),
            ];
        case 'auth.mismatch.ui_vs_machine_account':
            return [
                t('diagnosis.findings.accountMismatch.steps.signInSameAccount'),
                t('diagnosis.findings.accountMismatch.steps.cliReauth'),
            ];
        case 'machine.none_online':
            return [
                t('diagnosis.findings.noOnlineMachines.steps.startDaemon'),
                t('diagnosis.findings.noOnlineMachines.steps.checkNetwork'),
            ];
        case 'server.diagnostics_disabled':
            return [
                t('diagnosis.findings.serverDiagnosticsDisabled.steps.ok'),
            ];
        case 'server.unreachable':
            return [
                t('diagnosis.findings.serverUnreachable.steps.checkServerUrl'),
                t('diagnosis.findings.serverUnreachable.steps.tryAgain'),
            ];
        default:
            return [t('diagnosis.findings.generic.steps.reportIssue')];
    }
}

async function probeServerDiagnostics(timeoutMs: number): Promise<ServerDiagnosticsStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await serverFetch('/v1/diagnostics/bug-report-snapshot?lines=50', {
            method: 'GET',
            signal: controller.signal,
        });

        if (response.ok) return { state: 'ok' };
        if (response.status === 404) return { state: 'disabled' };
        if (response.status === 401) return { state: 'auth_error' };
        return { state: 'http_error', httpStatus: response.status };
    } catch (error) {
        if (controller.signal.aborted) return { state: 'timeout' };
        return { state: 'unknown', detail: error instanceof Error ? error.message : 'unknown error' };
    } finally {
        clearTimeout(timeout);
    }
}

export const DiagnosisView = React.memo(function DiagnosisView() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const copyFeedback = useTemporaryCopyFeedback();
    const styles = diagnosisStyles;
    const { fetchMachineDoctorSnapshot, readMachineDoctorSnapshot } = useMachineDoctorSnapshot();

    const activeServerSnapshot = getActiveServerSnapshot();
    const activeServerUrl = React.useMemo(
        () => normalizeUrl(activeServerSnapshot.serverUrl),
        [activeServerSnapshot.serverUrl],
    );
    const profile = useProfile();
    const machineListByServerId = useMachineListByServerId();

    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const [pastedJson, setPastedJson] = React.useState<string>('');
    const [pastedParseError, setPastedParseError] = React.useState<string | null>(null);
    const [pastedSnapshot, setPastedSnapshot] = React.useState<DoctorSnapshot | null>(null);

    const [machineRunById, setMachineRunById] = React.useState<Record<string, MachineRunStatus>>({});
    const [serverDiagnostics, setServerDiagnostics] = React.useState<ServerDiagnosticsStatus>({ state: 'ok' });
    const [report, setReport] = React.useState<DiagnosisReport | null>(null);

    const onlineMachinesActiveServer = React.useMemo(() => {
        const list = machineListByServerId[activeServerSnapshot.serverId];
        if (!Array.isArray(list)) return [];
        return list.filter((m) => isMachineOnline(m));
    }, [activeServerSnapshot.serverId, machineListByServerId]);

    const [running, runDiagnosis] = useHappyAction(async () => {
        const collected: Array<{ machineId: string; serverId: string; snapshot: DoctorSnapshot }> = [];

        setReport(null);
        setMachineRunById({});

        for (const machine of onlineMachinesActiveServer) {
            setMachineRunById((prev) => ({ ...prev, [machine.id]: { status: 'loading' } }));

            const nextStatus = await fetchMachineDoctorSnapshot({
                machineId: machine.id,
                serverId: activeServerSnapshot.serverId,
                timeoutMs: 4_000,
            });
            if (nextStatus.status !== 'ready') {
                setMachineRunById((prev) => ({ ...prev, [machine.id]: { status: 'error', detail: t('diagnosis.machine.invalidDoctorSnapshot') } }));
                continue;
            }

            collected.push({ machineId: machine.id, serverId: activeServerSnapshot.serverId, snapshot: nextStatus.snapshot });
            setMachineRunById((prev) => ({ ...prev, [machine.id]: { status: 'ready' } }));
        }

        const serverStatus = await probeServerDiagnostics(4_000);
        setServerDiagnostics(serverStatus);

        const parsedPasted = (() => {
            const result = parseDoctorSnapshotSafe(pastedJson);
            if (!pastedJson.trim()) return { ok: true as const, snapshot: null as DoctorSnapshot | null };
            if (result.ok) return { ok: true as const, snapshot: result.snapshot };
            return { ok: false as const, error: result.error };
        })();

        if (!parsedPasted.ok) {
            setPastedParseError(parsedPasted.error);
            setPastedSnapshot(null);
        } else {
            setPastedParseError(null);
            setPastedSnapshot(parsedPasted.snapshot);
        }

        const diagnosisReport = buildDiagnosisReport({
            ui: {
                activeServerId: activeServerSnapshot.serverId,
                activeServerUrl: activeServerUrl,
                profileId: profile?.id ?? null,
            },
            serverProfiles: serverProfiles.map((p) => ({ id: p.id, serverUrl: normalizeUrl(p.serverUrl) })),
            machinesByServerId: Object.fromEntries(
                Object.entries(machineListByServerId)
                    .map(([serverId, list]) => [serverId, Array.isArray(list) ? list.map((m) => ({ id: m.id, active: m.active })) : []]),
            ),
            machineDoctorSnapshots: collected,
            pastedDoctorSnapshots: parsedPasted.ok && parsedPasted.snapshot ? [parsedPasted.snapshot] : [],
            serverDiagnostics: serverStatus,
            nowMs: Date.now(),
        });

        setReport(diagnosisReport);
    });

    const [copying, copyReportJson] = useHappyAction(async () => {
        if (!report) return;
        const copied = await setClipboardStringSafe(JSON.stringify(report, null, 2));
        if (!copied) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied('report');
    });

    const [parsing, parsePasted] = useHappyAction(async () => {
        const result = parseDoctorSnapshotSafe(pastedJson);
        if (result.ok) {
            setPastedParseError(null);
            setPastedSnapshot(result.snapshot);
        } else {
            setPastedParseError(result.error);
            setPastedSnapshot(null);
        }
    });

    const cachedAttributionCount = React.useMemo(() => {
        const list = machineListByServerId[activeServerSnapshot.serverId];
        if (!Array.isArray(list)) return 0;
        let count = 0;
        for (const m of list) {
            const cached = readMachineDoctorSnapshot({ serverId: activeServerSnapshot.serverId, machineId: m.id });
            if (cached) count += 1;
        }
        return count;
    }, [activeServerSnapshot.serverId, machineListByServerId, readMachineDoctorSnapshot]);

    const failedMachineNames = React.useMemo(() => onlineMachinesActiveServer
        .filter((machine) => machineRunById[machine.id]?.status === 'error')
        .map((machine) => getMachineDisplayName(machine) ?? machine.id), [machineRunById, onlineMachinesActiveServer]);

    const accessibilityStatus = React.useMemo(() => {
        if (running) {
            return t('diagnosis.machineRuns.loading');
        }
        if (!report) {
            return null;
        }

        const summary: string[] = [];
        if (failedMachineNames.length > 0) {
            summary.push(
                `${t('diagnosis.sections.machineRuns')}: ${t('diagnosis.machineRuns.error')} ${failedMachineNames.length}.`,
            );
        }
        if (report.findings.length > 0) {
            const firstFinding = report.findings[0];
            if (firstFinding) {
                summary.push(
                    `${t('diagnosis.sections.findings')}: ${report.findings.length}. ${resolveFindingTitle(firstFinding)}.`,
                );
            }
        }
        return summary.length > 0 ? summary.join(' ') : t('diagnosis.findings.none');
    }, [failedMachineNames.length, report, running]);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="diagnosis-screen">
            <SettingsPageHeader
                description={t('diagnosis.pageDescription')}
                actions={(
                    <View style={styles.headerActions}>
                        <CopiedPill visible={copyFeedback.isCopied('report')} testID="diagnosis-copy-feedback" />
                        <SettingAnchor setting={DIAGNOSIS_SETTINGS.settings.copyReport}>
                            <RoundButton
                                testID="diagnosis-copy-button"
                                size="small"
                                display="inverted"
                                title={t(DIAGNOSIS_SETTINGS.settings.copyReport.titleKey)}
                                accessibilityHint={t('diagnosis.actions.copyReportSubtitle')}
                                leading={<Icon name="copy" size={14} color={theme.colors.text.secondary} />}
                                disabled={!report}
                                loading={copying}
                                onPress={copyReportJson}
                            />
                        </SettingAnchor>
                        <RoundButton
                            testID="diagnosis-run-button"
                            size="small"
                            title={t('diagnosis.actions.run')}
                            accessibilityHint={t('diagnosis.actions.runSubtitle')}
                            loading={running}
                            onPress={runDiagnosis}
                        />
                    </View>
                )}
            />
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                {accessibilityStatus ? (
                    <Text
                        testID="diagnosis-accessibility-status"
                        style={styles.accessibilityStatus}
                        accessibilityLiveRegion="polite"
                        {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                    >
                        {accessibilityStatus}
                    </Text>
                ) : null}
                <ItemGroup title={t('diagnosis.sections.overview')}>
                    <SettingRow
                        setting={DIAGNOSIS_SETTINGS.settings.activeServer}
                        icon={<Icon name="hard-drives" />}
                        subtitle={<Text style={{ color: theme.colors.text.secondary }}>{activeServerUrl || t('status.unknown')}</Text>}
                        detail={activeServerSnapshot.serverId}
                        onPress={() => router.push('/server')}
                    />
                    <Item
                        title={t('diagnosis.overview.account')}
                        detail={profile?.id ?? t('status.unknown')}
                        copy={profile?.id ?? false}
                    />
                    <Item
                        title={t('diagnosis.overview.onlineMachines')}
                        detail={`${onlineMachinesActiveServer.length}`}
                        subtitle={t('diagnosis.overview.cachedAttribution', { count: cachedAttributionCount })}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.findings')}>
                    {!report ? (
                        <Item
                            title={t('diagnosis.findings.notRun')}
                            subtitle={t('diagnosis.findings.notRunSubtitle')}
                            subtitleLines={0}
                            mode="info"
                        />
                    ) : report.findings.length === 0 && failedMachineNames.length === 0 ? (
                        <Item
                            title={t('diagnosis.findings.none')}
                            subtitle={t('diagnosis.findings.noneSubtitle')}
                            disabled
                        />
                    ) : report.findings.length === 0 ? (
                        <Item
                            testID="diagnosis-machine-run-summary"
                            title={t('diagnosis.machineRuns.error')}
                            subtitle={`${t('diagnosis.sections.machineRuns')}: ${failedMachineNames.join(', ')}`}
                            icon={<Icon name="warning-circle" size={24} color={theme.colors.state.danger.foreground} />}
                            disabled
                        />
                    ) : report.findings.map((finding, idx) => (
                        <Item
                            key={`${finding.code}-${idx}`}
                            testID={`diagnosis-finding-${finding.code.replaceAll('.', '_')}`}
                            title={resolveFindingTitle(finding)}
                            subtitle={
                                <View>
                                    <Text style={{ color: theme.colors.text.secondary }}>{resolveFindingSubtitle(finding)}</Text>
                                    <View style={{ height: 8 }} />
                                    {resolveFindingSteps(finding).map((step, stepIdx) => (
                                        <Text key={stepIdx} style={{ color: theme.colors.text.secondary }}>
                                            {`${stepIdx + 1}. ${step}`}
                                        </Text>
                                    ))}
                                    <View style={{ height: 8 }} />
                                    <Text style={{ color: theme.colors.text.secondary }}>
                                        {t('diagnosis.findings.code', { code: finding.code })}
                                    </Text>
                                </View>
                            }
                            icon={<Icon name="warning-circle" size={24} color={finding.severity === 'error' ? theme.colors.state.danger.foreground : theme.colors.accent.orange} />}
                            copy={finding.code}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.machineRuns')}>
                    {onlineMachinesActiveServer.length === 0 ? (
                        <Item
                            title={t('diagnosis.machineRuns.none')}
                            mode="info"
                        />
                    ) : onlineMachinesActiveServer.map((m) => {
                        const status = machineRunById[m.id] ?? { status: 'idle' as const };
                        const detail = status.status === 'loading'
                            ? t('diagnosis.machineRuns.loading')
                            : status.status === 'ready'
                                ? t('diagnosis.machineRuns.ready')
                                : status.status === 'error'
                                    ? t('diagnosis.machineRuns.error')
                                    : t('diagnosis.machineRuns.idle');
                        const subtitle = status.status === 'error' ? status.detail : undefined;

                        return (
                            <Item
                                key={m.id}
                                title={getMachineDisplayName(m) ?? m.id}
                                subtitle={subtitle}
                                detail={detail}
                                icon={<Icon name="laptop" size={24} color={theme.colors.text.secondary} />}
                            />
                        );
                    })}
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.serverProbe')}>
                    <Item
                        title={t('diagnosis.serverProbe.title')}
                        detail={serverDiagnostics.state}
                        subtitle={resolveServerDiagnosticsSubtitle(serverDiagnostics)}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.pasteDoctorJson')} description={t('diagnosis.pasteDoctorJson.footer')}>
                    <View style={styles.pasteContainer}>
                        <FieldTextInput
                            testID="diagnosis-paste-input"
                            style={styles.pasteInput}
                            placeholder={t('diagnosis.pasteDoctorJson.placeholder')}
                            accessibilityLabel={t('diagnosis.sections.pasteDoctorJson')}
                            value={pastedJson}
                            onChangeText={(value) => {
                                setPastedJson(value);
                                setPastedParseError(null);
                            }}
                            multiline
                            minLines={7}
                            monospace
                            editable={!running}
                        />
                        <View style={styles.pasteActions}>
                            <RoundButton
                                testID="diagnosis-parse-button"
                                size="small"
                                display="secondary"
                                title={t('diagnosis.pasteDoctorJson.parse')}
                                loading={parsing}
                                disabled={pastedJson.trim().length === 0}
                                onPress={parsePasted}
                            />
                        </View>
                        {pastedParseError ? (
                            <Text
                                style={styles.errorText}
                                accessibilityLiveRegion="polite"
                                {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                            >
                                {t('diagnosis.pasteDoctorJson.error', { error: pastedParseError })}
                            </Text>
                        ) : pastedSnapshot ? (
                            <Text
                                style={styles.okText}
                                accessibilityLiveRegion="polite"
                                {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                            >
                                {t('diagnosis.pasteDoctorJson.ok')}
                            </Text>
                        ) : (
                            <Text style={styles.helperText}>{t('diagnosis.pasteDoctorJson.helper')}</Text>
                        )}
                    </View>
                </ItemGroup>
            </View>
        </ItemList>
    );
});

const diagnosisStyles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    pasteActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    accessibilityStatus: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
    },
    pasteContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
    },
    pasteInput: {
        width: '100%',
        marginBottom: 8,
    },
    helperText: {
        color: theme.colors.text.secondary,
        marginTop: 6,
    },
    okText: {
        color: theme.colors.state.success.foreground,
        marginTop: 6,
    },
    errorText: {
        color: theme.colors.state.danger.foreground,
        marginTop: 6,
    },
}));
