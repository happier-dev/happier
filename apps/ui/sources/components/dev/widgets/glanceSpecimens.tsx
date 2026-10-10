import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ChangesGlanceView } from '@/components/sessions/companion/glances/ChangesGlance';
import { resolveLocalServicesGlanceRows } from '@/components/sessions/companion/glances/glanceModels';
import { LocalServicesGlanceView } from '@/components/sessions/companion/glances/LocalServicesGlance';
import { PaneLinkRowView } from '@/components/sessions/companion/glances/PaneLinkRow';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { buildLocalServiceRows, selectLocalServiceRunningCount } from '@/sync/domains/local/services/serviceRow';
import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * The Companion glances (lab `cwidgets` WC / WC3) at static props: the real glance views over the
 * real summary and service-row owners, fed the lab's session (branch `relay-retry`, web + relay
 * running, storybook not running). No store, no machine, no pane.
 */

function entry(path: string, kind: ScmWorkingEntry['kind'], added: number, removed: number): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind,
        includeStatus: ' ',
        pendingStatus: 'M',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: added, pendingRemoved: removed, isBinary: false },
    };
}

/** The lab session's working tree and services, shared with the group specimens. */
export const SNAPSHOT: ScmWorkingSnapshot = {
    projectKey: 'machine:/repo',
    fetchedAt: Date.now(),
    repo: { isRepo: true, rootPath: '/repo' },
    branch: { head: 'relay-retry', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [
        entry('relay/client.ts', 'modified', 42, 6),
        entry('relay/backoff.ts', 'untracked', 88, 0),
        entry('relay/client.test.ts', 'modified', 118, 3),
        entry('docs/relay.md', 'modified', 12, 2),
        entry('relay/index.ts', 'modified', 40, 46),
        entry('CHANGELOG.md', 'modified', 12, 30),
    ],
    totals: { includedFiles: 0, pendingFiles: 6, untrackedFiles: 1, includedAdded: 0, includedRemoved: 0, pendingAdded: 312, pendingRemoved: 87 },
};

function inventoryRow(id: string, port: number, command: string): LocalServiceInventoryRow {
    return {
        id,
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port,
        protocol: 'tcp',
        state: 'listening',
        source: 'detected',
        confidence: 'high',
        provenance: { process: { pid: port, lineagePids: [port], command, cwd: '/repo', redacted: true }, workspace: { path: '/repo', association: 'process_tree' } },
        presentation: { addressLabel: `localhost:${port}`, displayName: id },
    } as LocalServiceInventoryRow;
}

function runningTarget(id: string, port: number): LocalServiceLaunchTarget {
    return {
        id: `inventory:${id}`,
        source: 'inventory_entry',
        sourceClass: { kind: 'inventory_entry', inventoryEntryId: id },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: id,
        subtitle: `localhost:${port}`,
        confidence: 'high',
        state: 'available',
        actions: ['open'],
        browserTarget: {
            kind: 'externalUrl',
            targetId: `inventory-loopback:${id}`,
            url: `http://127.0.0.1:${port}/`,
            display: { title: id, addressLabel: `localhost:${port}` },
        },
    } as LocalServiceLaunchTarget;
}

export const SERVICE_ROWS = buildLocalServiceRows({
    inventoryRows: [inventoryRow('web', 8081, 'yarn web'), inventoryRow('relay', 3011, 'yarn relay')],
    launchTargets: [
        runningTarget('web', 8081),
        runningTarget('relay', 3011),
        {
            id: 'package:storybook',
            source: 'package_script',
            sourceClass: { kind: 'package_script', runTargetId: 'storybook', packageName: 'web', scriptName: 'storybook', cwd: '/repo' },
            machineId: 'machine-a',
            title: 'storybook',
            subtitle: 'yarn storybook',
            confidence: 'medium',
            state: 'unavailable',
            unavailableReason: 'package_script_start_unavailable',
            actions: [],
        } as unknown as LocalServiceLaunchTarget,
    ],
    sessionId: 'session-a',
    scope: 'workspace',
});

const NOOP = (): void => {};

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        width: 300,
        paddingHorizontal: 12,
        paddingBottom: 12,
        backgroundColor: theme.colors.surface.base,
        borderStartWidth: StyleSheet.hairlineWidth,
        borderStartColor: theme.colors.border.default,
    },
    phone: { width: 390, paddingHorizontal: 16, paddingBottom: 16, backgroundColor: theme.colors.surface.base },
    head: { paddingTop: 12, paddingBottom: 6 },
    title: { ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text.primary },
}));

function Column(props: Readonly<{ phone: boolean; links: boolean }>) {
    const summary = buildSessionScmSummary(SNAPSHOT);
    return (
        <View style={props.phone ? stylesheet.phone : stylesheet.rail}>
            <View style={stylesheet.head}>
                <Text style={stylesheet.title}>{t('sessionBoard.companion.title')}</Text>
            </View>
            {summary ? (
                <ChangesGlanceView testID="specimen-changes" frameStyle="plain" state={{ kind: 'ready', summary }} onReviewChanges={NOOP} />
            ) : null}
            <LocalServicesGlanceView
                testID="specimen-services"
                frameStyle="plain"
                machineName="MacBook Pro"
                state={{
                    kind: 'ready',
                    rows: resolveLocalServicesGlanceRows(SERVICE_ROWS),
                    runningCount: selectLocalServiceRunningCount(SERVICE_ROWS),
                }}
                onOpen={NOOP}
            />
            {props.links ? (
                <>
                    <PaneLinkRowView testID="specimen-pane-terminal" frameStyle="plain" label={t('settings.terminal')} icon="terminal" onOpen={NOOP} />
                    <PaneLinkRowView
                        testID="specimen-pane-agents"
                        frameStyle="plain"
                        label={t('sessionWork.title')}
                        icon="tree-structure"
                        fact={t('widgetGlances.runningCount', { count: 1 })}
                        onOpen={NOOP}
                    />
                </>
            ) : null}
        </View>
    );
}

export const GLANCE_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    WC: ({ phone }) => <Column phone={phone} links={false} />,
    WC3: ({ phone }) => <Column phone={phone} links />,
};
