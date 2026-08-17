import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    parseDoctorSnapshotSafe,
    sanitizeBugReportUrl,
    type DoctorSnapshot,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useProfile } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { useMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshot';
import { buildDiagnosisReport, type DiagnosisFinding, type DiagnosisReport, type ServerDiagnosticsStatus } from './engine/diagnosisEngine';
import { Icon } from '@/components/ui/icons/Icon';

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

        const online = onlineMachinesActiveServer.slice(0, 3);
        for (const machine of online) {
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

    React.useEffect(() => {
        parsePasted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    return (
        <ItemList style={{ paddingTop: 0 }} testID="diagnosis-screen">
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup title={t('diagnosis.sections.overview')}>
                    <Item
                        title={t('diagnosis.overview.activeServer')}
                        subtitle={<Text style={{ color: theme.colors.text.secondary }}>{activeServerUrl || t('status.unknown')}</Text>}
                        detail={activeServerSnapshot.serverId}
                        icon={<Icon name="hard-drives" size={24} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/server')}
                    />
                    <Item
                        title={t('diagnosis.overview.account')}
                        detail={profile?.id ?? t('status.unknown')}
                        icon={<Icon name="person" size={24} color={theme.colors.accent.purple} />}
                        copy={profile?.id ?? false}
                    />
                    <Item
                        title={t('diagnosis.overview.onlineMachines')}
                        detail={`${onlineMachinesActiveServer.length}`}
                        subtitle={t('diagnosis.overview.cachedAttribution', { count: cachedAttributionCount })}
                        icon={<Icon name="laptop" size={24} color={theme.colors.accent.indigo} />}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.actions')}>
                    <Item
                        testID="diagnosis-run-button"
                        title={t('diagnosis.actions.run')}
                        subtitle={t('diagnosis.actions.runSubtitle')}
                        icon={<Icon name="first-aid-kit" size={24} color={theme.colors.accent.orange} />}
                        onPress={runDiagnosis}
                        loading={running}
                        showChevron={false}
                    />
                    <Item
                        testID="diagnosis-copy-button"
                        title={t('diagnosis.actions.copyReport')}
                        subtitle={t('diagnosis.actions.copyReportSubtitle')}
                        icon={<Icon name="copy" size={24} color={theme.colors.accent.indigo} />}
                        onPress={copyReportJson}
                        rightElement={<CopiedPill visible={copyFeedback.isCopied('report')} testID="diagnosis-copy-feedback" />}
                        disabled={!report}
                        loading={copying}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.pasteDoctorJson')} footer={t('diagnosis.pasteDoctorJson.footer')}>
                    <View style={styles.pasteContainer}>
                        <TextInput
                            testID="diagnosis-paste-input"
                            style={styles.pasteInput}
                            placeholder={t('diagnosis.pasteDoctorJson.placeholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={pastedJson}
                            onChangeText={(value) => {
                                setPastedJson(value);
                                setPastedParseError(null);
                            }}
                            multiline
                            autoCapitalize="none"
                            autoCorrect={false}
                            textContentType="none"
                            editable={!running}
                        />
                        <Item
                            title={t('diagnosis.pasteDoctorJson.parse')}
                            icon={<Icon name="check" size={20} color={theme.colors.state.success.foreground} />}
                            onPress={parsePasted}
                            loading={parsing}
                            density="compact"
                            showChevron={false}
                        />
                        {pastedParseError ? (
                            <Text style={styles.errorText}>{t('diagnosis.pasteDoctorJson.error', { error: pastedParseError })}</Text>
                        ) : pastedSnapshot ? (
                            <Text style={styles.okText}>{t('diagnosis.pasteDoctorJson.ok')}</Text>
                        ) : (
                            <Text style={styles.helperText}>{t('diagnosis.pasteDoctorJson.helper')}</Text>
                        )}
                    </View>
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.machineRuns')}>
                    {onlineMachinesActiveServer.slice(0, 3).length === 0 ? (
                        <Item
                            title={t('diagnosis.machineRuns.none')}
                            icon={<Icon name="laptop" size={24} color={theme.colors.text.secondary} />}
                            disabled
                        />
                    ) : onlineMachinesActiveServer.slice(0, 3).map((m) => {
                        const status = machineRunById[m.id] ?? { status: 'idle' as const };
                        const detail = status.status === 'loading'
                            ? t('diagnosis.machineRuns.loading')
                            : status.status === 'ready'
                                ? t('diagnosis.machineRuns.ready')
                                : status.status === 'error'
                                    ? t('diagnosis.machineRuns.error')
                                    : t('diagnosis.machineRuns.idle');
                        const subtitle = status.status === 'error' ? status.detail : undefined;
                        const iconColor = status.status === 'ready'
                            ? theme.colors.state.success.foreground
                            : status.status === 'error'
                                ? theme.colors.state.danger.foreground
                                : theme.colors.text.secondary;

                        return (
                            <Item
                                key={m.id}
                                title={m.metadata?.displayName ?? m.metadata?.host ?? m.id}
                                subtitle={subtitle}
                                detail={detail}
                                icon={<Icon name="laptop" size={24} color={iconColor} />}
                            />
                        );
                    })}
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.serverProbe')}>
                    <Item
                        title={t('diagnosis.serverProbe.title')}
                        detail={serverDiagnostics.state}
                        subtitle={resolveServerDiagnosticsSubtitle(serverDiagnostics)}
                        icon={<Icon name="cloud" size={24} color={theme.colors.accent.blue} />}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.findings')}>
                    {!report ? (
                        <Item
                            title={t('diagnosis.findings.notRun')}
                            subtitle={t('diagnosis.findings.notRunSubtitle')}
                            icon={<Icon name="info" size={24} color={theme.colors.text.secondary} />}
                            disabled
                        />
                    ) : report.findings.length === 0 ? (
                        <Item
                            title={t('diagnosis.findings.none')}
                            subtitle={t('diagnosis.findings.noneSubtitle')}
                            icon={<Icon name="check-circle" size={24} color={theme.colors.state.success.foreground} />}
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
            </View>
        </ItemList>
    );
});

const diagnosisStyles = StyleSheet.create((theme) => ({
    pasteContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
    },
    pasteInput: {
        minHeight: Platform.select({ ios: 140, default: 160 }),
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text.primary,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
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
