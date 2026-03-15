import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    DoctorSnapshotSchema,
    parseDoctorSnapshotSafe,
    sanitizeBugReportUrl,
    sanitizeDoctorSnapshotUrls,
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
import { machineCollectBugReportDiagnostics } from '@/sync/ops/machines';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { readCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } from '../systemStatus/cache/machineDoctorSnapshotCache';
import { buildDiagnosisReport, type DiagnosisFinding, type DiagnosisReport, type ServerDiagnosticsStatus } from './engine/diagnosisEngine';

type MachineRunStatus =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready' }
    | { status: 'error'; detail: string };

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
    const styles = diagnosisStyles;

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

            const diagnostics = await machineCollectBugReportDiagnostics(machine.id, { timeoutMs: 4_000 });
            const rawDoctorSnapshot = (diagnostics as { doctorSnapshot?: unknown } | null)?.doctorSnapshot;
            const parsed = DoctorSnapshotSchema.safeParse(rawDoctorSnapshot);
            if (!parsed.success) {
                setMachineRunById((prev) => ({ ...prev, [machine.id]: { status: 'error', detail: t('diagnosis.machine.invalidDoctorSnapshot') } }));
                continue;
            }

            const snapshot = sanitizeDoctorSnapshotUrls(parsed.data);
            writeCachedMachineDoctorSnapshot({
                serverId: activeServerSnapshot.serverId,
                machineId: machine.id,
                cachedAt: Date.now(),
                snapshot,
            });

            collected.push({ machineId: machine.id, serverId: activeServerSnapshot.serverId, snapshot });
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
        await Clipboard.setStringAsync(JSON.stringify(report, null, 2));
        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('diagnosis.actions.copyReport') }));
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
            const cached = readCachedMachineDoctorSnapshot({ serverId: activeServerSnapshot.serverId, machineId: m.id });
            if (cached) count += 1;
        }
        return count;
    }, [activeServerSnapshot.serverId, machineListByServerId]);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="diagnosis-screen">
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup title={t('diagnosis.sections.overview')}>
                    <Item
                        title={t('diagnosis.overview.activeServer')}
                        subtitle={<Text style={{ color: theme.colors.textSecondary }}>{activeServerUrl || t('status.unknown')}</Text>}
                        detail={activeServerSnapshot.serverId}
                        icon={<Ionicons name="server-outline" size={24} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/server')}
                    />
                    <Item
                        title={t('diagnosis.overview.account')}
                        detail={profile?.id ?? t('status.unknown')}
                        icon={<Ionicons name="person-outline" size={24} color={theme.colors.accent.purple} />}
                        copy={profile?.id ?? false}
                    />
                    <Item
                        title={t('diagnosis.overview.onlineMachines')}
                        detail={`${onlineMachinesActiveServer.length}`}
                        subtitle={t('diagnosis.overview.cachedAttribution', { count: cachedAttributionCount })}
                        icon={<Ionicons name="laptop-outline" size={24} color={theme.colors.accent.indigo} />}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.actions')}>
                    <Item
                        testID="diagnosis-run-button"
                        title={t('diagnosis.actions.run')}
                        subtitle={t('diagnosis.actions.runSubtitle')}
                        icon={<Ionicons name="medkit-outline" size={24} color={theme.colors.accent.orange} />}
                        onPress={runDiagnosis}
                        loading={running}
                        showChevron={false}
                    />
                    <Item
                        testID="diagnosis-copy-button"
                        title={t('diagnosis.actions.copyReport')}
                        subtitle={t('diagnosis.actions.copyReportSubtitle')}
                        icon={<Ionicons name="copy-outline" size={24} color={theme.colors.accent.indigo} />}
                        onPress={copyReportJson}
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
                            icon={<Ionicons name="checkmark-outline" size={20} color={theme.colors.success} />}
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
                            icon={<Ionicons name="laptop-outline" size={24} color={theme.colors.textSecondary} />}
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
                            ? theme.colors.success
                            : status.status === 'error'
                                ? theme.colors.warningCritical
                                : theme.colors.textSecondary;

                        return (
                            <Item
                                key={m.id}
                                title={m.metadata?.displayName ?? m.metadata?.host ?? m.id}
                                subtitle={subtitle}
                                detail={detail}
                                icon={<Ionicons name="laptop-outline" size={24} color={iconColor} />}
                            />
                        );
                    })}
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.serverProbe')}>
                    <Item
                        title={t('diagnosis.serverProbe.title')}
                        detail={serverDiagnostics.state}
                        subtitle={serverDiagnostics.state === 'http_error' ? t('diagnosis.serverProbe.httpError', { status: (serverDiagnostics as any).httpStatus ?? '' }) : undefined}
                        icon={<Ionicons name="cloud-outline" size={24} color={theme.colors.accent.blue} />}
                    />
                </ItemGroup>

                <ItemGroup title={t('diagnosis.sections.findings')}>
                    {!report ? (
                        <Item
                            title={t('diagnosis.findings.notRun')}
                            subtitle={t('diagnosis.findings.notRunSubtitle')}
                            icon={<Ionicons name="information-circle-outline" size={24} color={theme.colors.textSecondary} />}
                            disabled
                        />
                    ) : report.findings.length === 0 ? (
                        <Item
                            title={t('diagnosis.findings.none')}
                            subtitle={t('diagnosis.findings.noneSubtitle')}
                            icon={<Ionicons name="checkmark-circle-outline" size={24} color={theme.colors.success} />}
                            disabled
                        />
                    ) : report.findings.map((finding, idx) => (
                        <Item
                            key={`${finding.code}-${idx}`}
                            testID={`diagnosis-finding-${finding.code.replaceAll('.', '_')}`}
                            title={resolveFindingTitle(finding)}
                            subtitle={
                                <View>
                                    <Text style={{ color: theme.colors.textSecondary }}>{resolveFindingSubtitle(finding)}</Text>
                                    <View style={{ height: 8 }} />
                                    {resolveFindingSteps(finding).map((step, stepIdx) => (
                                        <Text key={stepIdx} style={{ color: theme.colors.textSecondary }}>
                                            {`${stepIdx + 1}. ${step}`}
                                        </Text>
                                    ))}
                                    <View style={{ height: 8 }} />
                                    <Text style={{ color: theme.colors.textSecondary }}>
                                        {t('diagnosis.findings.code', { code: finding.code })}
                                    </Text>
                                </View>
                            }
                            icon={<Ionicons name="alert-circle-outline" size={24} color={finding.severity === 'error' ? theme.colors.warningCritical : theme.colors.accent.orange} />}
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
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        marginBottom: 8,
    },
    helperText: {
        color: theme.colors.textSecondary,
        marginTop: 6,
    },
    okText: {
        color: theme.colors.success,
        marginTop: 6,
    },
    errorText: {
        color: theme.colors.warningCritical,
        marginTop: 6,
    },
}));
