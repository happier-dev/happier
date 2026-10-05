import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { DetectedLocalServicesPane, type ServicesScope } from '@/components/sessions/localServices/DetectedLocalServicesPane';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import {
    applyLocalServiceInventorySnapshot,
    createLocalServiceInventoryState,
    type LocalServiceInventoryRow,
} from '@/sync/domains/local/services/inventory/store';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    type LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';
import { t } from '@/text';

/**
 * Dev-only specimen of the session's Local services pane (session-tabs lab S, services lab O) drawn
 * through the real `DetectedLocalServicesPane` with the lab's data: web (Vite) and storybook running,
 * docs ready to start. The pane's actions are local stand-ins (Open does nothing, Forget publishes the
 * same "Service hidden · Undo" notice the audited action does), so expand/collapse and the notice can
 * be captured frame by frame without a daemon.
 */
const MACHINE = 'machine-specimen';
const SESSION = 'session-specimen';
const NOOP = async () => undefined;

function inventoryRow(id: string, port: number, command: string): LocalServiceInventoryRow {
    return {
        id,
        machineId: MACHINE,
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: { scheme: 'http', host: '127.0.0.1', port, probeState: 'ready', probedAt: 1_000 },
        port,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: { process: { command } },
        presentation: { displayName: command === 'vite' ? 'Vite' : 'Storybook', addressLabel: `localhost:${port}` },
    };
}

function runningTarget(id: string, title: string, port: number, sessionId: string | undefined): LocalServiceLaunchTarget {
    return {
        id: `inventory:${id}`,
        source: 'inventory_entry',
        machineId: MACHINE,
        ...(sessionId ? { sessionId } : {}),
        title,
        confidence: 'high',
        state: 'available',
        actions: ['open', 'terminate_detected'],
        browserTarget: {
            kind: 'externalUrl',
            targetId: `inventory-loopback:${id}`,
            url: `http://127.0.0.1:${port}/`,
            display: { title, addressLabel: `localhost:${port}` },
        },
    } as LocalServiceLaunchTarget;
}

const INVENTORY = applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(), {
    v: 1,
    machineId: MACHINE,
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [inventoryRow('web', 5173, 'vite'), inventoryRow('storybook', 6006, 'storybook dev')],
    diagnostics: [],
});

const LAUNCHER = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
    v: 1,
    machineId: MACHINE,
    sessionId: SESSION,
    updatedAt: 3_000,
    targets: [
        runningTarget('web', 'web', 5173, SESSION),
        runningTarget('storybook', 'storybook', 6006, undefined),
        { id: 'package:docs:dev', source: 'package_script', sourceClass: { kind: 'package_script', runTargetId: 'docs:dev', packageName: 'docs', scriptName: 'dev' }, machineId: MACHINE, title: 'docs', confidence: 'medium', state: 'available', actions: ['start'], commandPreview: 'yarn docs:dev' } as LocalServiceLaunchTarget,
    ],
});

const MACHINE_ONLINE = { name: 'MacBook Pro', homeDir: null, reachability: 'reachable' as const };

function PublishedHeader(): React.ReactElement {
    const published = usePublishedPaneHeaderContent('services');
    return (
        <PaneHeader
            testID="services-specimen-header"
            title={t('localServices.inventory.title')}
            line={published?.line ?? null}
            actions={published?.action}
        />
    );
}

export function ServicesSpecimen(props: Readonly<{ phone: boolean }>): React.ReactElement {
    const [scope, setScope] = React.useState<ServicesScope>('workspace');
    const onForget = React.useCallback(async (target: LocalServiceLaunchTarget) => {
        publishPresentationNotice({
            key: `services-specimen-forget:${target.id}`,
            message: t('localServices.actions.hiddenNotice'),
            severity: 'info',
            undo: { label: t('sessionBoard.companion.actions.undo'), run: () => undefined },
        });
    }, []);
    return (
        <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'pane'}>
            <View style={styles.root}>
                <View testID="services-specimen" style={props.phone ? styles.panePhone : styles.pane}>
                    <PaneHeaderSlotProvider>
                        <PublishedHeader />
                        <PaneHeaderSlotScope slotKey="services">
                            <DetectedLocalServicesPane
                                inventoryState={INVENTORY}
                                launcherState={LAUNCHER}
                                sessionId={SESSION}
                                scope={scope}
                                onChangeScope={setScope}
                                machine={MACHINE_ONLINE}
                                onOpenServiceInBrowser={NOOP}
                                onStartLauncherTarget={NOOP}
                                onTerminateDetectedService={NOOP}
                                onForgetDetectedService={onForget}
                                onCopyServiceUrl={async () => true}
                                onRefresh={() => undefined}
                                testID="services-specimen-pane"
                            />
                        </PaneHeaderSlotScope>
                    </PaneHeaderSlotProvider>
                </View>
            </View>
        </SurfaceStateSizeProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset, padding: 16, alignItems: 'flex-start' },
    // The right sidebar's width in the lab (services O): a 460 px column.
    pane: {
        width: 460,
        height: 760,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    panePhone: { alignSelf: 'stretch', height: 760, overflow: 'hidden', backgroundColor: theme.colors.surface.base },
}));
