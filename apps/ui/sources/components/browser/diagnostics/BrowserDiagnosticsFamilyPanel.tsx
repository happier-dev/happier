import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { BrowserDiagnosticFidelityV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type {
    BrowserDiagnosticEventProjection,
    BrowserDiagnosticFamilyProjection,
    BrowserDiagnosticsStatus,
    BrowserViewDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

/**
 * The one row-and-detail pattern of the Diagnostics drawer (DESIGN-DIAG-1102).
 *
 * Every tab is a developer-tool list: one dense line per entry (state glyph, mono subject, right-aligned
 * tabular meta), its detail behind a disclosure as labelled fields, and ONE state line per tab that says
 * how much there is and where it came from. Nothing is said twice: no per-row title, no per-row source
 * badge, no raw-key dump under the row.
 */

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
    /** The view the family belongs to, for the store's event filter owner. */
    projection?: BrowserViewDiagnosticsProjection;
    testID: string;
}>;

export type DiagnosticsTone = 'neutral' | 'warning' | 'danger';

const LEAD_COLUMN_WIDTH_PX = 44;
const META_COLUMN_WIDTH_PX = 56;
const DETAIL_LABEL_WIDTH_PX = 112;

export const browserDiagnosticsPanelStyles = StyleSheet.create((theme) => ({
    root: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingVertical: theme.space.s8,
        gap: theme.space.s8,
    },
    inset: {
        paddingHorizontal: theme.space.s12,
    },
    header: {
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s12,
    },
    title: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    stateLine: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    warning: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        // Semantic foregrounds are fill colours (Q2: 2.20–3.55:1 as text in light). The words carry
        // the meaning in ink; the hue stays on the glyph beside them.
        color: theme.colors.text.primary,
    },
    familySection: {
        gap: theme.space.s6,
    },
    toolbar: {
        paddingHorizontal: theme.space.s12,
        gap: theme.space.s8,
    },
    list: {
        // Rows run edge to edge so their hairlines and tints read as one table.
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 26,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.subtle,
    },
    rowHover: {
        backgroundColor: theme.colors.surface.hover,
    },
    rowWarning: {
        backgroundColor: theme.colors.state.warning.background,
    },
    rowDanger: {
        backgroundColor: theme.colors.state.danger.background,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    caretSlot: {
        width: ICON_SIZE.xxs,
        alignItems: 'center',
    },
    glyphSlot: {
        width: ICON_SIZE.xs,
        alignItems: 'center',
    },
    lead: {
        ...Typography.variant('micro', 'semiBold'),
        ...Typography.mono(),
        width: LEAD_COLUMN_WIDTH_PX,
        color: theme.colors.text.primary,
    },
    subject: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.mono(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    stackedSubject: {
        flex: 1,
        minWidth: 0,
    },
    stackedMeta: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    subjectMuted: {
        color: theme.colors.text.secondary,
    },
    meta: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.tabular(),
        width: META_COLUMN_WIDTH_PX,
        textAlign: 'right',
        color: theme.colors.text.secondary,
    },
    columnLabel: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    columnLabelFlex: {
        flex: 1,
        minWidth: 0,
    },
    columnLabelMeta: {
        width: META_COLUMN_WIDTH_PX,
        textAlign: 'right',
    },
    detail: {
        gap: theme.space.s4,
        marginLeft: theme.space.s12 + ICON_SIZE.xxs + theme.space.s8,
        marginRight: theme.space.s12,
        marginVertical: theme.space.s6,
        padding: theme.space.s8,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
    },
    plainList: {
        gap: theme.space.s4,
    },
    sheet: {
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s12,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    fieldLabel: {
        ...Typography.variant('micro', 'regular'),
        width: DETAIL_LABEL_WIDTH_PX,
        color: theme.colors.text.secondary,
    },
    fieldValue: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.tabular(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    fieldValueMono: {
        ...Typography.mono(),
    },
    codeBlock: {
        gap: theme.space.s2,
        paddingTop: theme.space.s4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.subtle,
    },
    codeHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    codeLabel: {
        flex: 1,
        width: undefined,
    },
    codeText: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    fieldCopy: {
        marginTop: -6,
        marginBottom: -6,
    },
    sectionTitle: {
        ...Typography.variant('micro', 'semiBold'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s2,
    },
    note: {
        ...Typography.variant('micro', 'regular'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s12,
    },
    metricGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s12,
    },
    metricCell: {
        minWidth: 112,
        flexGrow: 1,
        flexBasis: 112,
        gap: theme.space.s2,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
    },
    metricLabel: {
        ...Typography.variant('micro', 'regular'),
        color: theme.colors.text.secondary,
    },
    metricValue: {
        ...Typography.variant('label', 'semiBold'),
        ...Typography.tabular(),
        color: theme.colors.text.primary,
    },
    metricVerdict: {
        ...Typography.variant('micro', 'regular'),
    },
}));

const styles = browserDiagnosticsPanelStyles;

export function sanitizeTestIdPart(input: string): string {
    return input.replace(/[^A-Za-z0-9_-]+/g, '_');
}

export function formatNumber(value: number): string {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatDurationMs(value: number): string {
    if (value >= 1000) {
        return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 1000)} s`;
    }
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ms`;
}

export function formatBytes(value: number): string {
    if (value < 1024) return `${formatNumber(value)} B`;
    if (value < 1024 * 1024) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1024)} kB`;
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MB`;
}

export function formatClockTime(epochMs: number): string {
    const date = new Date(epochMs);
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

/** Where a tab's data came from, said once per tab in words, never as a badge on every row. */
export function sourceLabel(fidelity: BrowserDiagnosticFidelityV1, trusted: boolean): string | null {
    if (!trusted) return t('browserDiagnostics.host.devtools.source.page');
    switch (fidelity) {
        case 'cdp':
            return t('browserDiagnostics.host.devtools.source.browser');
        case 'previewProxy':
            return t('browserDiagnostics.host.devtools.source.previewProxy');
        case 'nativeCallback':
            return t('browserDiagnostics.host.devtools.source.webView');
        case 'streamFrame':
            return t('browserDiagnostics.host.devtools.source.stream');
        case 'injectedPage':
            return t('browserDiagnostics.host.devtools.source.page');
        case 'unavailable':
            return null;
    }
}

export function diagnosticFamilyLabel(family: BrowserDiagnosticEventProjection['family']): string {
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

export function familyLabel(family: BrowserDiagnosticFamilyProjection): string {
    const label = diagnosticFamilyLabel(family.family);
    if (family.status === 'unavailable') {
        return t('browserDiagnostics.previewProxy.familyUnavailable', { family: label });
    }
    return t('browserDiagnostics.previewProxy.familyAvailable', { family: label });
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
        return value ? t('common.yes') : t('common.no');
    }
    return value;
}

/** A person-readable label for a typed field key; `null` for keys that are internal bookkeeping. */
export function fieldLabel(fieldKey: string): string | null {
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
        case 'encodedDataLength':
            return t('browserDiagnostics.host.fields.responseSize');
        case 'socketId':
        case 'sourceId':
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
        case 'accessibleName':
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
        case 'message':
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
        case 'resourceType':
        case 'initiatorType':
            return t('browserDiagnostics.host.fields.type');
        case 'mimeType':
            return t('browserDiagnostics.host.devtools.fields.contentType');
        case 'errorText':
            return t('browserDiagnostics.host.devtools.fields.error');
        case 'title':
            return t('browserDiagnostics.host.devtools.fields.title');
        case 'requestHeaders':
            return t('browserDiagnostics.host.devtools.fields.requestHeaders');
        case 'responseHeaders':
            return t('browserDiagnostics.host.devtools.fields.responseHeaders');
        case 'requestBodyText':
            return t('browserDiagnostics.host.devtools.fields.requestBody');
        case 'responseBodyText':
            return t('browserDiagnostics.host.devtools.fields.responseBody');
        case 'code':
            return t('browserDiagnostics.host.devtools.fields.closeCode');
        case 'wasClean':
            return t('browserDiagnostics.host.devtools.fields.closedCleanly');
        case 'accepted':
            return t('browserDiagnostics.host.devtools.fields.accepted');
        case 'bytesQueued':
            return t('browserDiagnostics.host.fields.requestSize');
        case 'requestId':
            return t('browserDiagnostics.host.devtools.fields.requestId');
        default:
            // Availability flags (`textAvailable`, `titleAvailable`, …) and correlation ids are
            // bookkeeping: the row already shows what they imply.
            return null;
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

export function getBrowserDiagnosticNumber(event: BrowserDiagnosticEventProjection, key: string): number | null {
    const value = getBrowserDiagnosticField(event, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getBrowserDiagnosticString(event: BrowserDiagnosticEventProjection, key: string): string | null {
    const value = getBrowserDiagnosticField(event, key);
    return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------------------------------
// Detail: labelled fields
// ---------------------------------------------------------------------------------------------------

export type DiagnosticsField = Readonly<{
    key: string;
    label: string;
    value: string;
    mono?: boolean;
    copy?: boolean;
}>;

/** Labelled fields from an event's typed detail; keys without a person-readable label are skipped. */
export function labelledEventFields(
    event: BrowserDiagnosticEventProjection,
    options: Readonly<{ mono?: readonly string[]; copy?: readonly string[]; omit?: readonly string[] }> = {},
): DiagnosticsField[] {
    const fields: DiagnosticsField[] = [];
    for (const field of event.detail?.fields ?? []) {
        if (options.omit?.includes(field.key)) continue;
        const label = fieldLabel(field.key);
        if (!label) continue;
        fields.push({
            key: field.key,
            label,
            value: formatBrowserDiagnosticFieldValue(field.value),
            mono: options.mono?.includes(field.key),
            copy: options.copy?.includes(field.key),
        });
    }
    return fields;
}

export function DiagnosticsFieldList(props: Readonly<{
    fields: readonly DiagnosticsField[];
    testID: string;
    variant?: 'detail' | 'sheet' | 'plain';
}>): React.ReactElement | null {
    if (props.fields.length === 0) return null;
    return (
        <View testID={props.testID} style={props.variant === 'sheet' ? styles.sheet : props.variant === 'plain' ? styles.plainList : styles.detail}>
            {props.fields.map((field) => (
                <View key={field.key} testID={`${props.testID}-${sanitizeTestIdPart(field.key)}`} style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>{field.label}</Text>
                    <Text selectable style={[styles.fieldValue, field.mono ? styles.fieldValueMono : null]}>
                        {field.value}
                    </Text>
                    {field.copy ? (
                        <CopyIconButton
                            text={field.value}
                            style={styles.fieldCopy}
                            testID={`${props.testID}-${sanitizeTestIdPart(field.key)}-copy`}
                        />
                    ) : null}
                </View>
            ))}
        </View>
    );
}

/**
 * A block of machine text inside a detail (headers, a request or response body): its label, the text
 * in mono at a bounded height, copy, and one line when the owner capped it.
 */
export function DiagnosticsCodeBlock(props: Readonly<{
    label: string;
    text: string;
    truncated?: boolean;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={styles.codeBlock}>
            <View style={styles.codeHeader}>
                <Text style={[styles.fieldLabel, styles.codeLabel]}>{props.label}</Text>
                <CopyIconButton text={props.text} style={styles.fieldCopy} testID={`${props.testID}-copy`} />
            </View>
            <Text selectable numberOfLines={24} style={styles.codeText}>{props.text}</Text>
            {props.truncated ? (
                <Text style={styles.fieldLabel}>{t('browserDiagnostics.host.devtools.network.bodyTruncated')}</Text>
            ) : null}
        </View>
    );
}

// ---------------------------------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------------------------------

/**
 * Whether the tab is phone-narrow. A row with several meta columns then moves them beneath its subject
 * (DESIGN.md: only a short value sits beside a label on a phone), so the subject keeps its width.
 */
const DiagnosticsNarrowContext = React.createContext(false);
// ---------------------------------------------------------------------------------------------------

export type DiagnosticsMetaCell = Readonly<{
    text: string;
    tone?: DiagnosticsTone;
}>;

function toneGlyph(tone: DiagnosticsTone): IconName | null {
    switch (tone) {
        case 'danger':
            return 'x-circle';
        case 'warning':
            return 'warning';
        case 'neutral':
            return null;
    }
}

/**
 * One entry, one line. A row with a detail is its disclosure's header: the caret leads, and the
 * detail opens in place beneath it. Colour is state only — the glyph and a faint row tint for a
 * warning or a failure; the words stay ink.
 */
export function DiagnosticsRow(props: Readonly<{
    testID: string;
    tone?: DiagnosticsTone;
    lead?: string | null;
    subject: string;
    subjectMuted?: boolean;
    meta?: readonly (DiagnosticsMetaCell | null)[];
    copyText?: string;
    renderDetail?: () => React.ReactNode;
    accessibilityLabel?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const tone = props.tone ?? 'neutral';
    const glyph = toneGlyph(tone);
    const expandable = typeof props.renderDetail === 'function';
    const toggle = React.useCallback(() => setOpen((value) => !value), []);

    const glyphColor = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : theme.colors.state.attention.foreground;
    const metaColor = (cell: DiagnosticsMetaCell) => cell.tone === 'danger'
        ? { color: theme.colors.state.danger.textForeground ?? theme.colors.state.danger.foreground }
        : cell.tone === 'warning'
            ? { color: theme.colors.state.attention.textForeground ?? theme.colors.state.attention.foreground }
            : null;

    const narrow = React.useContext(DiagnosticsNarrowContext);
    const metaCells = props.meta ?? [];
    const stackMeta = narrow && metaCells.length > 1;
    const subjectText = (
        <Text
            testID={`${props.testID}-subject`}
            numberOfLines={open ? undefined : 1}
            selectable={!expandable}
            style={[styles.subject, props.subjectMuted ? styles.subjectMuted : null]}
        >
            {props.subject}
        </Text>
    );
    const content = (
        <>
            <View style={styles.caretSlot}>
                {expandable ? <DisclosureCaret expanded={open} density="compact" /> : null}
            </View>
            <View style={styles.glyphSlot}>
                {glyph ? <Icon name={glyph} size={ICON_SIZE.xs} color={glyphColor} /> : null}
            </View>
            {props.lead ? <Text numberOfLines={1} style={styles.lead}>{props.lead}</Text> : null}
            {stackMeta ? (
                <View style={styles.stackedSubject}>
                    {subjectText}
                    <Text numberOfLines={1} style={styles.stackedMeta}>
                        {metaCells.filter((cell): cell is DiagnosticsMetaCell => cell !== null).map((cell, index) => (
                            <Text key={index} style={metaColor(cell)}>{index > 0 ? ` · ${cell.text}` : cell.text}</Text>
                        ))}
                    </Text>
                </View>
            ) : subjectText}
            {stackMeta ? null : metaCells.map((cell, index) => (
                cell ? (
                    <Text key={index} numberOfLines={1} style={[styles.meta, metaColor(cell)]}>{cell.text}</Text>
                ) : <View key={index} style={{ width: META_COLUMN_WIDTH_PX }} />
            ))}
            {props.copyText ? (
                <CopyIconButton text={props.copyText} style={styles.fieldCopy} testID={`${props.testID}-copy`} />
            ) : null}
        </>
    );

    const rowStyle = [
        styles.row,
        tone === 'danger' ? styles.rowDanger : tone === 'warning' ? styles.rowWarning : null,
        hovered && expandable ? styles.rowHover : null,
    ];

    return (
        <View>
            {expandable ? (
                <Pressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={props.accessibilityLabel ?? props.subject}
                    onPress={toggle}
                    onHoverIn={() => setHovered(true)}
                    onHoverOut={() => setHovered(false)}
                    style={rowStyle}
                >
                    {content}
                </Pressable>
            ) : (
                <View testID={props.testID} style={rowStyle}>{content}</View>
            )}
            {expandable && open ? props.renderDetail?.() : null}
        </View>
    );
}

/** Column labels over a table-shaped list (Network, Resources), aligned with the row's slots. */
export function DiagnosticsColumnHeader(props: Readonly<{
    lead?: string;
    subject: string;
    meta: readonly string[];
    testID?: string;
}>): React.ReactElement {
    const narrow = React.useContext(DiagnosticsNarrowContext);
    return (
        <View testID={props.testID} style={styles.headerRow}>
            <View style={styles.caretSlot} />
            <View style={styles.glyphSlot} />
            {props.lead ? <Text style={[styles.columnLabel, { width: LEAD_COLUMN_WIDTH_PX }]}>{props.lead}</Text> : null}
            <Text style={[styles.columnLabel, styles.columnLabelFlex]}>{props.subject}</Text>
            {narrow ? null : props.meta.map((label) => (
                <Text key={label} style={[styles.columnLabel, styles.columnLabelMeta]}>{label}</Text>
            ))}
        </View>
    );
}

// ---------------------------------------------------------------------------------------------------
// Tab frame: one state line, optional filter + search, the list
// ---------------------------------------------------------------------------------------------------

/** A tab's filter segments; what each one selects is decided by the store's selectors, not here. */
export type DiagnosticsFilterSegments = readonly Readonly<{ id: string; label: string }>[];

const NARROW_PANEL_PX = 420;

export function BrowserDiagnosticsFamilyPanelFrame<T>(props: BrowserDiagnosticsFamilyPanelProps & Readonly<{
    familyKey: BrowserDiagnosticsProductFamilyKey;
    items: readonly T[];
    /** How much there is, in the tab's own noun ("12 messages"); omitted for single-snapshot tabs. */
    countLabel?: (count: number) => string;
    /** One honest note about what this page does not share (said once, not on every row). */
    note?: string | null;
    segments?: DiagnosticsFilterSegments;
    searchPlaceholder?: string;
    /**
     * The visible items for a segment and search query. Every tab delegates this to the store's
     * selector owner (`selectBrowserDiagnosticEvents`, `…Requests`, `…StorageRows`, `…ResourceRows`).
     */
    selectItems?: (segment: string, query: string) => readonly T[];
    renderItems: (items: readonly T[]) => React.ReactNode;
}>): React.ReactElement {
    const stateTestID = `${props.testID}-${props.familyKey}-${familyStatusTestIdPart(props.family.status)}`;
    const unavailable = props.family.status === 'unavailable';
    const [segment, setSegment] = React.useState(props.segments?.[0]?.id ?? 'all');
    const [query, setQuery] = React.useState('');
    const [narrow, setNarrow] = React.useState(false);
    const onPanelLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width < NARROW_PANEL_PX;
        setNarrow((current) => (current === next ? current : next));
    }, []);

    const visible = React.useMemo(() => {
        return props.selectItems ? props.selectItems(segment, query) : props.items;
    }, [props.items, props.selectItems, query, segment]);

    // Events the family's typed projection does not cover still say what the owner summarised, as
    // plain rows, so an older or partial producer never renders as an empty tab.
    const summaryEvents = React.useMemo(
        () => (props.items.length === 0 ? props.events.filter((event) => typeof event.summary === 'string' && event.summary.length > 0) : []),
        [props.events, props.items.length],
    );
    const shownCount = props.items.length > 0 ? props.items.length : summaryEvents.length;
    const source = unavailable ? null : sourceLabel(props.family.fidelity, props.family.trusted);
    const stateText = unavailable
        ? t('browserDiagnostics.host.familyNotReported')
        : props.family.status === 'stale'
            ? t('browserDiagnostics.host.devtools.stale')
            : shownCount === 0
                ? t('browserDiagnostics.host.devtools.empty')
                : [props.countLabel?.(shownCount), source].filter(Boolean).join(' · ');

    const showToolbar = !unavailable && props.items.length > 0 && props.selectItems && (props.segments || props.searchPlaceholder);
    const filterBar = props.segments ? (
        <SegmentedTabBar
            testIDPrefix={`${props.testID}-${props.familyKey}-filter`}
            tabs={props.segments}
            activeTabId={segment}
            onSelectTab={setSegment}
            compact
            segmentSizing="content"
            role="radiogroup"
            accessibilityLabel={t('browserDiagnostics.host.devtools.filterLabel')}
        />
    ) : null;

    return (
        <DiagnosticsNarrowContext.Provider value={narrow}>
        <View testID={`${props.testID}-${props.familyKey}-panel`} style={styles.familySection} onLayout={onPanelLayout}>
            <View testID={`${props.testID}-family-${props.family.family}`} style={styles.inset}>
                <Text
                    testID={stateTestID}
                    style={props.family.status === 'stale' ? styles.warning : styles.stateLine}
                >
                    {stateText}
                </Text>
            </View>
            {!unavailable && props.note && props.items.length > 0 ? (
                <Text testID={`${props.testID}-${props.familyKey}-note`} style={styles.note}>{props.note}</Text>
            ) : null}
            {showToolbar ? (
                <View style={styles.toolbar}>
                    {props.searchPlaceholder ? (
                        <>
                            <CompactSearchField
                                testID={`${props.testID}-${props.familyKey}-search`}
                                value={query}
                                onChangeText={setQuery}
                                placeholder={props.searchPlaceholder}
                                {...(narrow ? {} : { accessory: filterBar ?? undefined })}
                            />
                            {narrow ? filterBar : null}
                        </>
                    ) : filterBar}
                </View>
            ) : null}
            {!unavailable && summaryEvents.length > 0 ? (
                <View style={styles.list}>
                    {summaryEvents.map((event) => renderBrowserDiagnosticEvent(event, props.testID, `${props.testID}-${props.familyKey}-row-${sanitizeTestIdPart(event.eventId)}`))}
                </View>
            ) : null}
            {unavailable || props.items.length === 0 ? null : visible.length > 0 ? (
                <View style={styles.list}>{props.renderItems(visible)}</View>
            ) : (
                <Text testID={`${props.testID}-${props.familyKey}-no-matches`} style={styles.note}>
                    {t('browserDiagnostics.host.devtools.noMatches')}
                </Text>
            )}
        </View>
        </DiagnosticsNarrowContext.Provider>
    );
}

/** A labelled metric cell: value with its unit, and a verdict word when the metric has one. */
export function DiagnosticsMetric(props: Readonly<{
    label: string;
    value: string;
    verdict?: Readonly<{ label: string; tone: 'success' | 'warning' | 'danger' }> | null;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const verdictColor = props.verdict?.tone === 'danger'
        ? theme.colors.state.danger.textForeground ?? theme.colors.state.danger.foreground
        : props.verdict?.tone === 'warning'
            ? theme.colors.state.attention.textForeground ?? theme.colors.state.attention.foreground
            : theme.colors.state.success.textForeground ?? theme.colors.state.success.foreground;
    return (
        <View testID={props.testID} style={styles.metricCell}>
            <Text style={styles.metricLabel}>{props.label}</Text>
            <Text style={styles.metricValue}>{props.value}</Text>
            {props.verdict ? (
                <Text testID={`${props.testID}-verdict`} style={[styles.metricVerdict, { color: verdictColor }]}>
                    {props.verdict.label}
                </Text>
            ) : null}
        </View>
    );
}

/** The generic row for a family without its own panel: its summary and its labelled fields. */
export function renderBrowserDiagnosticEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
    rowTestIDOverride?: string,
): React.ReactElement {
    const rowTestID = rowTestIDOverride ?? `${testID}-event-${sanitizeTestIdPart(event.eventId)}`;
    const fields = labelledEventFields(event);
    return (
        <DiagnosticsRow
            key={event.eventId}
            testID={rowTestID}
            subject={event.summary ?? event.kind}
            meta={[{ text: formatClockTime(event.capturedAtMs) }]}
            renderDetail={fields.length > 0
                ? () => <DiagnosticsFieldList fields={fields} testID={`${rowTestID}-detail`} />
                : undefined}
        />
    );
}
