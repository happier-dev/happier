import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type {
    BrowserDiagnosticEventDetail,
    BrowserDiagnosticEventProjection,
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticResourceEntry,
    BrowserDiagnosticsStatus,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BrowserDiagnosticsFidelityBadge } from './BrowserDiagnosticsFidelityBadge';

export type BrowserDiagnosticsProductFamilyKey =
    | 'console'
    | 'pageError'
    | 'network'
    | 'elements'
    | 'resources'
    | 'storage'
    | 'pageInfo'
    | 'performance';

export type BrowserDiagnosticsFamilyPanelProps = Readonly<{
    family: BrowserDiagnosticFamilyProjection;
    events: readonly BrowserDiagnosticEventProjection[];
    testID: string;
}>;

export type BrowserDiagnosticsFamilyEventRenderer = (
    event: BrowserDiagnosticEventProjection,
    testID: string,
    familyKey: BrowserDiagnosticsProductFamilyKey,
) => React.ReactElement;

export const browserDiagnosticsPanelStyles = StyleSheet.create((theme) => ({
    root: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 10,
    },
    header: {
        gap: 6,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    title: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    status: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    warning: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        // Q2 measured the theme's semantic FOREGROUNDS as text at 2.20–3.55:1 in light theme —
        // they are fill colours, not text colours. The words carry their own meaning here, so
        // they take `text.primary`; the hue stays on the border/glyph beside them, where it is a
        // redundant cue rather than the only one.
        color: theme.colors.text.primary,
    },
    content: {
        gap: 8,
    },
    familySection: {
        gap: 6,
    },
    flowRow: {
        gap: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    flowTitle: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    flowMeta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    familyList: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    familyPill: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    familyText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    detail: {
        gap: 2,
        marginTop: 2,
    },
    detailRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    detailKey: {
        ...Typography.keyHint(),
        color: theme.colors.text.secondary,
        minWidth: 96,
    },
    detailValue: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    detailListLabel: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    detailListItem: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
    },
    panelGroup: {
        gap: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    panelGroupTitle: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    panelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    panelCell: {
        minWidth: 72,
        gap: 2,
    },
    panelCellWide: {
        flexGrow: 1,
        flexBasis: 160,
        minWidth: 120,
        gap: 2,
    },
    panelLabel: {
        ...Typography.pillLabel(),
        color: theme.colors.text.secondary,
    },
    panelValue: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
    },
    consoleMessage: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
    },
    metricGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    metricCell: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 8,
        paddingVertical: 6,
        minWidth: 88,
        gap: 2,
    },
    keyRow: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 8,
        paddingVertical: 5,
    },
}));

export function sanitizeTestIdPart(input: string): string {
    return input.replace(/[^A-Za-z0-9_-]+/g, '_');
}

export function productFamilyTitle(familyKey: BrowserDiagnosticsProductFamilyKey): string {
    switch (familyKey) {
        case 'console':
            return t('browserDiagnostics.host.families.console');
        case 'pageError':
            return t('browserDiagnostics.host.families.pageError');
        case 'elements':
            return t('browserDiagnostics.host.families.elements');
        case 'resources':
            return t('browserDiagnostics.host.families.resources');
        case 'storage':
            return t('browserDiagnostics.host.families.storage');
        case 'performance':
            return t('browserDiagnostics.host.families.performance');
        case 'network':
            return t('browserDiagnostics.host.families.network');
        case 'pageInfo':
            return t('browserDiagnostics.host.families.pageInfo');
    }
}

export function formatNumber(value: number): string {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function statusLabel(status: BrowserDiagnosticsStatus): string {
    switch (status) {
        case 'available':
            return t('browserDiagnostics.previewProxy.status.available');
        case 'stale':
            return t('browserDiagnostics.previewProxy.status.stale');
        case 'unavailable':
            return t('browserDiagnostics.previewProxy.status.unavailable');
    }
}

export function familyLabel(family: BrowserDiagnosticFamilyProjection): string {
    const label = diagnosticFamilyLabel(family.family);
    if (family.status === 'unavailable') {
        return t('browserDiagnostics.previewProxy.familyUnavailable', { family: label });
    }
    return t('browserDiagnostics.previewProxy.familyAvailable', { family: label });
}

export function eventTitle(event: BrowserDiagnosticEventProjection): string {
    if (event.family === 'pageError') {
        return t('browserDiagnostics.host.eventTitles.pageError');
    }
    if (event.family === 'console') {
        return t('browserDiagnostics.host.eventTitles.console');
    }
    return t('browserDiagnostics.host.eventTitle', {
        family: diagnosticFamilyLabel(event.family),
        kind: eventKindLabel(event.kind),
    });
}

function diagnosticFamilyLabel(family: BrowserDiagnosticEventProjection['family']): string {
    switch (family) {
        case 'console':
            return t('browserDiagnostics.host.families.console');
        case 'pageError':
            return t('browserDiagnostics.host.families.pageError');
        case 'elements':
            return t('browserDiagnostics.host.families.elements');
        case 'resources':
            return t('browserDiagnostics.host.families.resources');
        case 'storage':
            return t('browserDiagnostics.host.families.storage');
        case 'performance':
            return t('browserDiagnostics.host.families.performance');
        case 'network':
            return t('browserDiagnostics.host.families.network');
        case 'pageInfo':
            return t('browserDiagnostics.host.families.pageInfo');
        default:
            return t('browserDiagnostics.host.families.other');
    }
}

function eventKindLabel(kind: string): string {
    switch (kind) {
        case 'page.error':
            return t('browserDiagnostics.host.eventKinds.pageError');
        case 'console.entry':
            return t('browserDiagnostics.host.eventKinds.consoleEntry');
        case 'network.request':
        case 'network.response':
            return t('browserDiagnostics.host.eventKinds.network');
        default:
            return t('browserDiagnostics.host.eventKinds.event');
    }
}

function eventSummary(event: BrowserDiagnosticEventProjection): string {
    return event.summary ?? t('browserDiagnostics.host.eventSummaryUnavailable');
}

function hasSensitiveAssignment(value: string): boolean {
    if (/\b(?:sid|token|secret|password|authorization|auth|payload|body|requestBody|responseBody)\b\s*[=:]/i.test(value)) {
        return true;
    }
    if (/\b(?:cookie|set-cookie|localStorage|sessionStorage|indexedDB|storage)\b\s*[=:]/i.test(value)) {
        return true;
    }
    return /[=:]\s*[^;]*(?:secret|password|bearer\s+|sid=|token=)/i.test(value);
}

function stripSensitiveSummaryClauses(value: string): string | null {
    const clauses = value
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (clauses.length <= 1) {
        return hasSensitiveAssignment(value) ? null : value;
    }

    const safeClauses = clauses.filter((entry) => !hasSensitiveAssignment(entry));
    return safeClauses.length > 0 ? safeClauses.join('; ') : null;
}

export function safeEventDetail(event: BrowserDiagnosticEventProjection): string {
    const summary = eventSummary(event);
    const safeSummary = stripSensitiveSummaryClauses(summary);
    return safeSummary ?? t('browserDiagnostics.host.eventSummaryUnavailable');
}

function familyStatusTestIdPart(status: BrowserDiagnosticsStatus): string {
    switch (status) {
        case 'available':
            return 'available';
        case 'stale':
            return 'partial';
        case 'unavailable':
            return 'unavailable';
    }
}

export function formatBrowserDiagnosticFieldValue(value: string | number | boolean): string {
    if (typeof value === 'number') {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    return value;
}

export function fieldLabel(fieldKey: string): string {
    switch (fieldKey) {
        case 'method':
            return t('browserDiagnostics.host.fields.method');
        case 'status':
        case 'statusCode':
            return t('browserDiagnostics.host.fields.status');
        case 'url':
        case 'path':
            return t('browserDiagnostics.host.fields.url');
        case 'durationMs':
            return t('browserDiagnostics.host.fields.duration');
        case 'requestBytes':
            return t('browserDiagnostics.host.fields.requestSize');
        case 'responseBytes':
            return t('browserDiagnostics.host.fields.responseSize');
        case 'socketId':
            return t('browserDiagnostics.host.fields.socket');
        case 'state':
            return t('browserDiagnostics.host.fields.state');
        case 'framesSent':
            return t('browserDiagnostics.host.fields.framesSent');
        case 'framesReceived':
            return t('browserDiagnostics.host.fields.framesReceived');
        case 'bytesSent':
            return t('browserDiagnostics.host.fields.bytesSent');
        case 'bytesReceived':
            return t('browserDiagnostics.host.fields.bytesReceived');
        case 'messageCount':
            return t('browserDiagnostics.host.fields.messages');
        case 'hasProtocol':
        case 'protocolCount':
            return t('browserDiagnostics.host.fields.protocol');
        case 'selectorPath':
            return t('browserDiagnostics.host.fields.selector');
        case 'backendNodeRef':
            return t('browserDiagnostics.host.fields.backendNode');
        case 'rectAvailable':
            return t('browserDiagnostics.host.fields.rect');
        case 'accessibleNameAvailable':
            return t('browserDiagnostics.host.fields.accessibleName');
        case 'storageType':
            return t('browserDiagnostics.host.fields.storageType');
        case 'keyCount':
            return t('browserDiagnostics.host.fields.keyCount');
        case 'keysTruncated':
            return t('browserDiagnostics.host.fields.truncated');
        case 'level':
            return t('browserDiagnostics.host.fields.level');
        case 'argCount':
            return t('browserDiagnostics.host.fields.arguments');
        case 'text':
            return t('browserDiagnostics.host.fields.message');
        case 'serviceWorker':
            return t('browserDiagnostics.host.fields.serviceWorker');
        case 'webgl':
            return t('browserDiagnostics.host.fields.webgl');
        case 'webrtc':
            return t('browserDiagnostics.host.fields.webrtc');
        case 'nodeCount':
            return t('browserDiagnostics.host.fields.nodeCount');
        case 'elementCount':
            return t('browserDiagnostics.host.fields.elementCount');
        case 'maxDepth':
            return t('browserDiagnostics.host.fields.maxDepth');
        case 'readyState':
            return t('browserDiagnostics.host.fields.readyState');
        case 'lcpMs':
            return t('browserDiagnostics.host.fields.lcp');
        case 'clsScore':
            return t('browserDiagnostics.host.fields.cls');
        case 'inpMs':
            return t('browserDiagnostics.host.fields.inp');
        case 'fcpMs':
            return t('browserDiagnostics.host.fields.fcp');
        case 'longTaskCount':
            return t('browserDiagnostics.host.fields.longTasks');
        case 'longTaskTotalMs':
            return t('browserDiagnostics.host.fields.longTaskTime');
        case 'navResponseEndMs':
            return t('browserDiagnostics.host.fields.responseEnd');
        case 'navDomContentLoadedMs':
            return t('browserDiagnostics.host.fields.domContentLoaded');
        case 'navLoadEventEndMs':
            return t('browserDiagnostics.host.fields.loadEventEnd');
        default:
            return fieldKey;
    }
}

export function getBrowserDiagnosticField(
    event: BrowserDiagnosticEventProjection,
    key: string,
): string | number | boolean | undefined {
    return event.detail?.fields.find((field) => field.key === key)?.value;
}

export function getBrowserDiagnosticFieldText(
    event: BrowserDiagnosticEventProjection,
    key: string,
): string | null {
    const value = getBrowserDiagnosticField(event, key);
    return typeof value === 'undefined' ? null : formatBrowserDiagnosticFieldValue(value);
}

export function renderPanelField(props: Readonly<{
    label: string;
    value: string | number | boolean | null | undefined;
    testID: string;
    wide?: boolean;
}>): React.ReactElement | null {
    if (typeof props.value === 'undefined' || props.value === null || props.value === '') return null;
    return (
        <View testID={props.testID} style={props.wide ? browserDiagnosticsPanelStyles.panelCellWide : browserDiagnosticsPanelStyles.panelCell}>
            <Text style={browserDiagnosticsPanelStyles.panelLabel}>{props.label}</Text>
            <Text style={browserDiagnosticsPanelStyles.panelValue}>
                {typeof props.value === 'string' ? props.value : formatBrowserDiagnosticFieldValue(props.value)}
            </Text>
        </View>
    );
}

export function renderPanelMetric(props: Readonly<{
    label: string;
    value: string | number | boolean | null | undefined;
    testID: string;
}>): React.ReactElement | null {
    if (typeof props.value === 'undefined' || props.value === null || props.value === '') return null;
    return (
        <View testID={props.testID} style={browserDiagnosticsPanelStyles.metricCell}>
            <Text style={browserDiagnosticsPanelStyles.panelLabel}>{props.label}</Text>
            <Text style={browserDiagnosticsPanelStyles.panelValue}>
                {typeof props.value === 'string' ? props.value : formatBrowserDiagnosticFieldValue(props.value)}
            </Text>
        </View>
    );
}

function formatResourceEntry(entry: BrowserDiagnosticResourceEntry): string {
    const head = entry.name ?? entry.initiatorType ?? '-';
    const meta: string[] = [];
    if (entry.initiatorType && entry.name) meta.push(entry.initiatorType);
    if (typeof entry.durationMs === 'number') {
        meta.push(`${formatBrowserDiagnosticFieldValue(entry.durationMs)} ms`);
    }
    return meta.length > 0 ? `${head} (${meta.join(', ')})` : head;
}

/**
 * Render the typed, family-specific body of a diagnostics event (DEV-1). This consumes the typed
 * `detail` projection — scalar `fields` as label/value rows, a `storage.keyInventory` key list, and
 * `resources.snapshot` entries — so the LOCAL owner sees real per-family data instead of one
 * collapsed summary string. All values are already sanitized upstream (the egress classifier SSOT).
 */
export function renderBrowserDiagnosticEventDetail(
    detail: BrowserDiagnosticEventDetail,
    rowTestID: string,
): React.ReactElement | null {
    const hasContent = detail.fields.length > 0 || (detail.keys?.length ?? 0) > 0 || (detail.entries?.length ?? 0) > 0;
    if (!hasContent) return null;
    return (
        <View testID={`${rowTestID}-detail-fields`} style={browserDiagnosticsPanelStyles.detail}>
            {detail.fields.map((field) => (
                <View key={field.key} testID={`${rowTestID}-field-${sanitizeTestIdPart(field.key)}`} style={browserDiagnosticsPanelStyles.detailRow}>
                    <Text style={browserDiagnosticsPanelStyles.detailKey}>{field.key}</Text>
                    <Text style={browserDiagnosticsPanelStyles.detailValue}>{formatBrowserDiagnosticFieldValue(field.value)}</Text>
                </View>
            ))}
            {detail.keys && detail.keys.length > 0 ? (
                <View testID={`${rowTestID}-keys`} style={browserDiagnosticsPanelStyles.detail}>
                    <Text style={browserDiagnosticsPanelStyles.detailListLabel}>
                        {t('browserDiagnostics.host.detail.keys', { count: formatNumber(detail.keys.length) })}
                    </Text>
                    {detail.keys.map((key, index) => (
                        <Text
                            key={`${key}-${index}`}
                            testID={`${rowTestID}-key-${index}`}
                            style={browserDiagnosticsPanelStyles.detailListItem}
                        >
                            {key}
                        </Text>
                    ))}
                </View>
            ) : null}
            {detail.entries && detail.entries.length > 0 ? (
                <View testID={`${rowTestID}-entries`} style={browserDiagnosticsPanelStyles.detail}>
                    <Text style={browserDiagnosticsPanelStyles.detailListLabel}>
                        {t('browserDiagnostics.host.detail.entries', { count: formatNumber(detail.entries.length) })}
                    </Text>
                    {detail.entries.map((entry, index) => (
                        <Text
                            key={`${entry.name ?? 'entry'}-${index}`}
                            testID={`${rowTestID}-entry-${index}`}
                            style={browserDiagnosticsPanelStyles.detailListItem}
                        >
                            {formatResourceEntry(entry)}
                        </Text>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

export function renderBrowserDiagnosticEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
    options: Readonly<{
        detailTestID?: string;
        rowTestID?: string;
    }> = {},
): React.ReactElement {
    const genericRowTestID = `${testID}-event-${sanitizeTestIdPart(event.eventId)}`;
    const rowTestID = options.rowTestID ?? genericRowTestID;
    return (
        <View key={event.eventId} testID={rowTestID} style={browserDiagnosticsPanelStyles.flowRow}>
            <View
                testID={rowTestID === genericRowTestID ? undefined : genericRowTestID}
                style={browserDiagnosticsPanelStyles.titleRow}
            >
                <Text style={browserDiagnosticsPanelStyles.flowTitle}>{eventTitle(event)}</Text>
                <BrowserDiagnosticsFidelityBadge
                    fidelity={event.fidelity}
                    testID={`${rowTestID}-fidelity-${event.fidelity}`}
                />
            </View>
            <Text testID={options.detailTestID} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            {event.detail ? renderBrowserDiagnosticEventDetail(event.detail, rowTestID) : null}
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

export function renderBrowserDiagnosticFamilyEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
    familyKey: BrowserDiagnosticsProductFamilyKey,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    return renderBrowserDiagnosticEvent(event, testID, {
        rowTestID: `${testID}-${familyKey}-row-${eventId}`,
        detailTestID: `${testID}-${familyKey}-detail-${eventId}`,
    });
}

export function BrowserDiagnosticsFamilyPanelFrame(props: BrowserDiagnosticsFamilyPanelProps & Readonly<{
    familyKey: BrowserDiagnosticsProductFamilyKey;
    renderEvent?: BrowserDiagnosticsFamilyEventRenderer;
}>): React.ReactElement {
    const stateTestID = `${props.testID}-${props.familyKey}-${familyStatusTestIdPart(props.family.status)}`;

    return (
        <View testID={`${props.testID}-${props.familyKey}-panel`} style={browserDiagnosticsPanelStyles.familySection}>
            <View testID={`${props.testID}-family-${props.family.family}`} style={browserDiagnosticsPanelStyles.titleRow}>
                <Text style={browserDiagnosticsPanelStyles.flowTitle}>{productFamilyTitle(props.familyKey)}</Text>
                <BrowserDiagnosticsFidelityBadge
                    fidelity={props.family.fidelity}
                    testID={`${props.testID}-${props.familyKey}-fidelity-${props.family.fidelity}`}
                />
            </View>
            <Text
                testID={stateTestID}
                style={props.family.status === 'available'
                    ? browserDiagnosticsPanelStyles.flowMeta
                    : browserDiagnosticsPanelStyles.warning}
            >
                {props.family.status === 'unavailable' ? familyLabel(props.family) : statusLabel(props.family.status)}
            </Text>
            {props.events.length > 0 ? (
                props.events.map((event) => (
                    props.renderEvent
                        ? props.renderEvent(event, props.testID, props.familyKey)
                        : renderBrowserDiagnosticFamilyEvent(event, props.testID, props.familyKey)
                ))
            ) : (
                <Text testID={`${props.testID}-${props.familyKey}-empty`} style={browserDiagnosticsPanelStyles.subtitle}>
                    {t('browserDiagnostics.host.eventsEmpty')}
                </Text>
            )}
        </View>
    );
}
