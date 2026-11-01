import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { UpdatesContent } from '@/components/updates/UpdatesContent';
import { UpdatesPopoverButton } from '@/components/updates/UpdatesPopoverButton';
import { Text } from '@/components/ui/text/Text';
import type { DesktopUpdaterSnapshot } from '@/desktop/updates/desktopUpdater';
import { buildAppUpdateItem } from '@/updates/items/buildAppUpdateItem';
import {
    buildAgentCliUpdateItem,
    buildInstallableUpdateItem,
    buildRemoteCliUpdateItem,
    buildThisComputerCliUpdateItem,
} from '@/updates/items/buildMachineUpdateItems';
import { buildUpdatesSummary, type UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import type { UpdatesContentModel, UpdatesGroup } from '@/updates/useUpdatesContentModel';

/**
 * Developer preview of the Updates surface: the real components fed by the real item builders
 * with representative facts, one app state at a time (`?state=available|downloading|ready|failed`).
 * Used for visual QA of states a live machine rarely shows on demand. Dev tools only.
 */
type DemoState = 'available' | 'downloading' | 'ready' | 'failed' | 'checking';

const IDLE = { running: false, step: null, errorMessage: null } as const;

function desktopSnapshot(state: DemoState): DesktopUpdaterSnapshot {
    const base: DesktopUpdaterSnapshot = {
        phase: 'available',
        version: '0.2.14',
        currentVersion: '0.2.13',
        downloadPercent: null,
        failure: null,
        skipped: false,
        refreshing: false,
        checkedAt: Date.now() - 2 * 60 * 60 * 1000,
    };
    if (state === 'downloading') return { ...base, phase: 'downloading', downloadPercent: 42 };
    if (state === 'ready') return { ...base, phase: 'ready' };
    if (state === 'failed') return { ...base, phase: 'failed', failure: 'download' };
    return base;
}

function buildDemoGroups(state: DemoState): UpdatesGroup[] {
    const app = buildAppUpdateItem({
        platformOs: 'web',
        desktopHost: true,
        title: 'Happier',
        native: { updateUrl: null, required: false },
        webUiUpdateAvailable: false,
        desktop: desktopSnapshot(state),
        ota: { isDownloading: false, downloadProgress: null, isUpdatePending: false },
    }).item;
    const thisCli = buildThisComputerCliUpdateItem({
        machineId: 'laptop',
        title: 'Happier CLI',
        facts: { currentVersion: '0.2.13', latestVersion: '0.2.14', managed: true, updateCommand: null },
        task: IDLE,
    });
    const claude = buildAgentCliUpdateItem({
        machineId: 'laptop',
        agentId: 'claude',
        title: 'Claude Code',
        online: true,
        data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
        task: state === 'failed'
            ? { running: false, step: null, errorMessage: 'The update didn’t finish. Try again.', logPath: '/Users/lee/.happier/logs/provider-installs/claude-2026-09-25.log' }
            : IDLE,
    });
    const codex = buildAgentCliUpdateItem({
        machineId: 'laptop',
        agentId: 'codex',
        title: 'Codex',
        online: true,
        data: { available: true, version: '0.61.0', latestVersion: '0.61.0', installSource: 'npm', updateSupported: false, updateCommand: 'npm install -g @openai/codex@latest' },
        task: IDLE,
    });
    const gh = buildInstallableUpdateItem({
        machineId: 'laptop',
        installableKey: 'gh',
        title: 'GitHub CLI',
        online: true,
        data: {
            installed: true, installedVersion: '2.61.0', sourceKind: 'managed', lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
            latestVersionCheck: { ok: true, latestVersion: '2.62.0', label: null },
        },
        task: IDLE,
    });
    const remote = buildRemoteCliUpdateItem({
        machineId: 'studio',
        title: 'Happier CLI',
        online: true,
        platform: 'darwin',
        happyCliVersion: '0.2.12',
        facts: {
            currentVersion: '0.2.12',
            latestVersion: '0.2.14',
            channel: 'stable',
            installSource: 'managed',
            updateCommand: 'happier self update',
            canUpdateRemotely: true,
            lastUpdate: { targetVersion: '0.2.14', outcome: 'pendingReconnect', at: Date.now(), message: null },
        },
        remoteUpdateAdvertised: true,
        task: IDLE,
    });
    const offline = buildRemoteCliUpdateItem({
        machineId: 'nas', title: 'Happier CLI', online: false, platform: 'linux', happyCliVersion: '0.2.11',
        facts: { currentVersion: '0.2.11', latestVersion: '0.2.14', channel: 'stable', installSource: 'managed', updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null },
        remoteUpdateAdvertised: null,
        task: IDLE,
    });
    const windows = buildRemoteCliUpdateItem({
        machineId: 'windows', title: 'Happier CLI', online: true, platform: 'win32', happyCliVersion: '0.2.16-dev.9',
        facts: {
            currentVersion: '0.2.16-dev.9', latestVersion: '0.2.16-dev.9', channel: 'dev',
            installSource: 'managed', updateCommand: 'hdev self update', canUpdateRemotely: false, lastUpdate: null,
        },
        remoteUpdateAdvertised: false,
        task: IDLE,
    });
    return [
        { id: 'app', kind: 'app', machineName: null, machineId: null, online: true, items: [app] },
        {
            id: 'thisComputer', kind: 'thisComputer', machineName: 'MacBook-Pro', machineId: 'laptop', online: true,
            items: [thisCli, claude, codex, gh].filter((item): item is NonNullable<typeof item> => item != null),
        },
        { id: 'machine:studio', kind: 'machine', machineName: 'Studio-Mac-mini', machineId: 'studio', online: true, items: [remote] },
        { id: 'machine:windows', kind: 'machine', machineName: 'Windows', machineId: 'windows', online: true, items: [windows] },
        { id: 'machine:nas', kind: 'machine', machineName: 'nas.local', machineId: 'nas', online: false, items: [offline] },
    ];
}

const noop = () => {};
const asyncNoop = async () => {};

const PILL_SUMMARIES: ReadonlyArray<UpdatesSummary> = [
    { actionableCount: 3, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true },
    { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'running', status: 'running', visible: true },
    { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'ready', status: 'ready', visible: true },
    { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'failed', status: 'failed', visible: true },
    { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'required', status: 'required', visible: true },
    { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'completed', status: 'upToDate', visible: true },
];

export default function UpdatesDemoScreen() {
    const params = useLocalSearchParams<{ state?: string; only?: string }>();
    // `only=` renders one section at the top, for a capture that nothing else scrolls over.
    const only = params.only === 'pills' || params.only === 'popover' || params.only === 'screen' ? params.only : null;
    const state: DemoState = params.state === 'downloading' || params.state === 'ready' || params.state === 'failed' || params.state === 'checking' ? params.state : 'available';
    const model = React.useMemo<UpdatesContentModel>(() => {
        const groups = buildDemoGroups(state);
        return {
            summary: buildUpdatesSummary(groups.flatMap((group) => group.items)),
            groups,
            checkedAt: Date.now() - 2 * 60 * 60 * 1000,
            uncheckedMachineCount: 0,
            sessionsRunningOn: new Set(),
            runItem: asyncNoop,
            updateAll: asyncNoop,
            stopAfterCurrent: noop,
            batch: null,
            checking: state === 'checking',
            checkNow: noop,
            skipAppVersion: null,
            openWhatsNew: noop,
            whatsNewUnread: false,
        };
    }, [state]);

    return (
        <ScrollView style={styles.page} contentContainerStyle={styles.content} testID="updates-demo">
            {only == null || only === 'pills' ? <>
            <Text style={styles.caption}>Pill</Text>
            <View style={styles.pills} testID="updates-demo.pills">
                {PILL_SUMMARIES.map((summary) => (
                    <UpdatesPopoverButton key={summary.phase} summary={summary} variant="icon" testID={`updates-demo.pill.${summary.phase}`} />
                ))}
                <UpdatesPopoverButton summary={PILL_SUMMARIES[0]} variant="icon" testID="updates-demo.rail" />
            </View>
            </> : null}
            {only == null || only === 'popover' ? <>
            <Text style={styles.caption}>Popover</Text>
            <View style={styles.popover} testID="updates-demo.popover">
                <UpdatesContent model={model} presentation="popover" />
            </View>
            </> : null}
            {only == null || only === 'screen' ? <>
            <Text style={styles.caption}>Screen</Text>
            <View style={styles.screen} testID="updates-demo.screen">
                <UpdatesContent model={model} presentation="screen" />
            </View>
            </> : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        padding: 16,
        gap: 12,
        alignItems: 'flex-start',
    },
    caption: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    pills: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
    },
    popover: {
        width: '100%',
        maxWidth: 400,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    screen: {
        width: '100%',
        maxWidth: 720,
        backgroundColor: theme.colors.background.canvas,
    },
}));
