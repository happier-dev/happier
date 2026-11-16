import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { BACKED_SIMULATOR_SIDEBAND_KINDS_V1 } from '@happier-dev/protocol/devices/simulator/actionBuilders';
import type { SimulatorSidebandKindV1, SimulatorSidebandMessageV1 } from '@happier-dev/protocol/devices/simulator/sidebandV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SidePaneInspectorSections } from '@/components/ui/lists/SidePaneInspectorSections';
import { Text } from '@/components/ui/text/Text';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { SimulatorDeviceTools } from './SimulatorDeviceTools';
import { simulatorStreamStyles } from './styles';
import type { useSimulatorDeviceOperation } from './useSimulatorDeviceOperation';

const sidebandKinds: readonly SimulatorSidebandKindV1[] = BACKED_SIMULATOR_SIDEBAND_KINDS_V1;

const ALL_SIDEBAND_KINDS: readonly SimulatorSidebandKindV1[] = [
    'logs',
    'accessibility_tree',
    'device_config',
    'app_metadata',
    'network_diagnostics',
    'route',
    'capture_health',
];

function sidebandTitle(kind: SimulatorSidebandKindV1): string {
    switch (kind) {
        case 'logs':
            return t('simulatorPreview.sidebands.logs');
        case 'accessibility_tree':
            return t('simulatorPreview.sidebands.accessibilityTree');
        case 'device_config':
            return t('simulatorPreview.sidebands.deviceConfig');
        case 'app_metadata':
            return t('simulatorPreview.sidebands.appMetadata');
        case 'network_diagnostics':
            return t('simulatorPreview.sidebands.networkDiagnostics');
        case 'route':
            return t('simulatorPreview.sidebands.route');
        case 'capture_health':
            return t('simulatorPreview.sidebands.captureHealth');
    }
}

function captureHealthStatusLabel(status: SimulatorSidebandMessageV1 & { kind: 'capture_health' }): string {
    switch (status.status) {
        case 'available':
            return t('simulatorPreview.availability.available');
        case 'degraded':
            return t('simulatorPreview.availability.degraded');
        case 'unavailable':
            return t('simulatorPreview.availability.unavailable');
    }
    return t('simulatorPreview.availability.unavailable');
}

function simulatorReasonBody(reasonCode: string): string {
    return resolveReasonCopy({ reasonCode, kind: 'simulatorPreview' }).body;
}

function isSimulatorSidebandKind(value: string): value is SimulatorSidebandKindV1 {
    return ALL_SIDEBAND_KINDS.includes(value as SimulatorSidebandKindV1);
}

function orderedSidebandKinds(sidebands: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>>): readonly SimulatorSidebandKindV1[] {
    const present = new Set(
        Object.keys(sidebands)
            .filter(isSimulatorSidebandKind),
    );
    return ALL_SIDEBAND_KINDS.filter((kind) => sidebandKinds.includes(kind) || present.has(kind));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatStructuredValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    if (Array.isArray(value)) return t('simulatorPreview.sidebands.arrayValue', { count: String(value.length) });
    if (isRecord(value)) return t('simulatorPreview.sidebands.objectValue', { count: String(Object.keys(value).length) });
    return t('simulatorPreview.sidebands.valueUnavailable');
}

function flattenRecord(value: unknown, prefix = ''): readonly Readonly<{ key: string; value: string }>[] {
    if (!isRecord(value)) {
        return [];
    }
    return Object.entries(value).flatMap(([key, entry]) => {
        const nextKey = prefix ? `${prefix}.${key}` : key;
        if (isRecord(entry)) {
            const childRows = flattenRecord(entry, nextKey);
            return childRows.length > 0 ? childRows : [{ key: nextKey, value: formatStructuredValue(entry) }];
        }
        return [{ key: nextKey, value: formatStructuredValue(entry) }];
    });
}

function sidebandRows(message: SimulatorSidebandMessageV1): readonly Readonly<{ key: string; value: string }>[] {
    switch (message.kind) {
        case 'logs':
            return [
                { key: t('simulatorPreview.sidebands.fields.level'), value: message.level },
                { key: t('simulatorPreview.sidebands.fields.message'), value: message.message },
            ];
        case 'accessibility_tree':
            return flattenRecord(message.tree);
        case 'device_config':
            return flattenRecord(message.config);
        case 'app_metadata':
            return flattenRecord(message.metadata);
        case 'network_diagnostics':
            return flattenRecord(message.diagnostics);
        case 'route':
            return [{ key: t('simulatorPreview.sidebands.fields.route'), value: message.route }];
        case 'capture_health':
            return [
                { key: t('simulatorPreview.sidebands.fields.status'), value: captureHealthStatusLabel(message) },
                ...(message.reasonCode
                    ? [{ key: t('simulatorPreview.sidebands.fields.reason'), value: simulatorReasonBody(message.reasonCode) }]
                    : []),
            ];
    }
}

function SidebandRows(props: Readonly<{
    message: SimulatorSidebandMessageV1 | undefined;
    testID: string;
}>): React.ReactElement {
    const rows = props.message ? sidebandRows(props.message) : [];
    if (rows.length === 0) {
        return <Item testID={`${props.testID}-empty`} title={t('simulatorPreview.sidebands.empty')} mode="info" />;
    }
    return (
        <>
            {rows.map((row) => (
                <Item key={row.key} testID={`${props.testID}-field:${row.key}`} title={row.key} detail={row.value} mode="info" />
            ))}
        </>
    );
}

/**
 * The on-demand Tools panel: rare stream presets, the device's test tools (apps, links, settings,
 * accessibility) and capture health
 * with its diagnostics. Only what the producer backs is listed; nothing here is needed to watch or drive
 * the device, so it stays closed until asked for.
 */
export function SimulatorSidebandPanel(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: Partial<SimulatorPreviewActions>;
    /** Runs the device operations of the device tools; without it only stream and capture tools show. */
    operations?: ReturnType<typeof useSimulatorDeviceOperation>;
    onClose: () => void;
    /** A narrow pane: the panel takes the stage's place instead of standing beside it. */
    stacked?: boolean;
    testID: string;
}>): React.ReactElement {
    const { controls, sidebands, diagnostics } = props.viewModel;
    const kinds = React.useMemo(() => orderedSidebandKinds(sidebands), [sidebands]);
    const streamPresets = [
        controls.canSetQuality ? { id: 'lower-quality', title: t('simulatorPreview.toolbar.reduceBandwidth'), onPress: props.actions.lowerQuality } : null,
        controls.canSetFps ? { id: 'set-fps', title: t('simulatorPreview.toolbar.fps'), onPress: props.actions.setFps } : null,
        controls.canSetScale ? { id: 'set-scale', title: t('simulatorPreview.toolbar.scale'), onPress: props.actions.setScale } : null,
    ].filter((entry) => entry !== null);

    return (
        <View testID={props.testID} style={[simulatorStreamStyles.tools, props.stacked ? simulatorStreamStyles.toolsStacked : null]}>
            <View style={simulatorStreamStyles.toolsHeader}>
                <Text style={simulatorStreamStyles.toolsTitle}>{t('simulatorPreview.viewer.tools')}</Text>
                <IconButton
                    testID={`${props.testID}-close`}
                    iconName="x"
                    variant="plain"
                    accessibilityLabel={t('simulatorPreview.viewer.closeTools')}
                    tooltip={t('simulatorPreview.viewer.closeTools')}
                    onPress={props.onClose}
                />
            </View>
            <ScrollView contentContainerStyle={simulatorStreamStyles.toolsBody} testID={`${props.testID}-drawer`}>
                <SidePaneInspectorSections>
                {streamPresets.length > 0 ? (
                    <ItemGroup title={t('simulatorPreview.viewer.streamSection')} description={t('simulatorPreview.viewer.streamDescription')}>
                        {streamPresets.map((preset) => (
                            <Item
                                key={preset.id}
                                testID={`${props.testID}-${preset.id}`}
                                title={preset.title}
                                showChevron={false}
                                disabled={!controls.canWatch}
                                onPress={() => { void preset.onPress?.(); }}
                            />
                        ))}
                    </ItemGroup>
                ) : null}
                {props.operations && props.viewModel.resource ? (
                    <SimulatorDeviceTools
                        key={props.viewModel.resource.simulatorId}
                        viewModel={props.viewModel}
                        operations={props.operations}
                        testID={props.testID}
                    />
                ) : null}
                {kinds.map((kind) => {
                    const title = sidebandTitle(kind);
                    return (
                        <ItemGroup
                            key={kind}
                            testID={`${props.testID}-${kind}`}
                            title={title}
                            action={(
                                <IconButton
                                    testID={`${props.testID}-refresh:${kind}`}
                                    iconName="arrow-clockwise"
                                    variant="plain"
                                    accessibilityLabel={t('simulatorPreview.sidebands.refreshA11y', { section: title })}
                                    tooltip={t('simulatorPreview.sidebands.refreshA11y', { section: title })}
                                    onPress={() => { void props.actions.requestSideband?.(kind); }}
                                />
                            )}
                        >
                            <SidebandRows message={sidebands[kind]} testID={`${props.testID}-${kind}`} />
                            {kind === 'capture_health' ? diagnostics.map((diagnostic) => (
                                <Item
                                    key={`${diagnostic.kind ?? 'diagnostic'}:${diagnostic.reasonCode}`}
                                    testID={`${props.testID}-diagnostic:${diagnostic.reasonCode}`}
                                    title={simulatorReasonBody(diagnostic.reasonCode)}
                                    titleLines={0}
                                    mode="info"
                                />
                            )) : null}
                        </ItemGroup>
                    );
                })}
                </SidePaneInspectorSections>
            </ScrollView>
        </View>
    );
}
