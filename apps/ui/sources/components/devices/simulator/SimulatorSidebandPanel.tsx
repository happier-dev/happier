import * as React from 'react';
import { View } from 'react-native';
import {
    BACKED_SIMULATOR_SIDEBAND_KINDS_V1,
    type SimulatorSidebandKindV1,
    type SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import type { SimulatorPreviewDiagnostic } from '@/sync/domains/devices/simulator/types';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';

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
        return (
            <Text style={simulatorStreamStyles.sidebandText}>
                {t('simulatorPreview.sidebands.empty')}
            </Text>
        );
    }
    return (
        <View style={simulatorStreamStyles.sidebandStructuredRows}>
            {rows.map((row) => (
                <View
                    key={row.key}
                    testID={`${props.testID}-field:${row.key}`}
                    style={simulatorStreamStyles.sidebandStructuredRow}
                >
                    <Text style={simulatorStreamStyles.sidebandStructuredKey}>{row.key}</Text>
                    <Text style={simulatorStreamStyles.sidebandStructuredValue}>{row.value}</Text>
                </View>
            ))}
        </View>
    );
}

export function SimulatorSidebandPanel(props: Readonly<{
    sidebands: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>>;
    diagnostics: readonly SimulatorPreviewDiagnostic[];
    onRequestSideband: (kind: SimulatorSidebandKindV1) => void;
    testID: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const kinds = React.useMemo(() => orderedSidebandKinds(props.sidebands), [props.sidebands]);
    return (
        <View testID={props.testID} style={simulatorStreamStyles.sidebandPanel}>
            <View style={simulatorStreamStyles.sidebandHeader}>
                <Text style={simulatorStreamStyles.titleText}>{t('simulatorPreview.sidebands.title')}</Text>
                <IconButton
                    testID={open ? `${props.testID}-close` : `${props.testID}-open`}
                    iconName={open ? 'chevron-forward' : 'bug-outline'}
                    accessibilityLabel={open ? t('simulatorPreview.sidebands.close') : t('simulatorPreview.sidebands.open')}
                    tooltip={open ? t('simulatorPreview.sidebands.close') : t('simulatorPreview.sidebands.open')}
                    size={32}
                    iconSize={16}
                    onPress={() => setOpen((current) => !current)}
                />
            </View>
            {open ? (
                <View testID={`${props.testID}-drawer`} style={simulatorStreamStyles.sidebandDrawer}>
                    {props.diagnostics.map((diagnostic) => (
                        <View
                            key={`${diagnostic.kind ?? 'diagnostic'}:${diagnostic.reasonCode}`}
                            style={simulatorStreamStyles.diagnosticRow}
                            testID={`${props.testID}-diagnostic:${diagnostic.reasonCode}`}
                        >
                            <Text style={simulatorStreamStyles.badgeText}>
                                {simulatorReasonBody(diagnostic.reasonCode)}
                            </Text>
                        </View>
                    ))}
                    {kinds.map((kind) => {
                        const message = props.sidebands[kind];
                        const title = sidebandTitle(kind);
                        return (
                            <View
                                key={kind}
                                style={simulatorStreamStyles.sidebandSection}
                                testID={`${props.testID}-${kind}`}
                            >
                                <View style={simulatorStreamStyles.sidebandHeader}>
                                    <Text style={simulatorStreamStyles.badgeText}>{title}</Text>
                                    <IconButton
                                        testID={`${props.testID}-refresh:${kind}`}
                                        iconName="refresh-outline"
                                        accessibilityLabel={t('simulatorPreview.sidebands.refreshA11y', { section: title })}
                                        tooltip={t('simulatorPreview.sidebands.refreshA11y', { section: title })}
                                        size={28}
                                        iconSize={14}
                                        onPress={() => props.onRequestSideband(kind)}
                                    />
                                </View>
                                <SidebandRows message={message} testID={`${props.testID}-${kind}`} />
                            </View>
                        );
                    })}
                </View>
            ) : null}
        </View>
    );
}
