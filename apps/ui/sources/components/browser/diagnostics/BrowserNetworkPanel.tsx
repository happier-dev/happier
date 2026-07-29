import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import { BrowserDiagnosticsFidelityBadge } from './BrowserDiagnosticsFidelityBadge';
import {
    browserDiagnosticsPanelStyles,
    BrowserDiagnosticsFamilyPanelFrame,
    type BrowserDiagnosticsFamilyPanelProps,
    eventTitle,
    fieldLabel,
    getBrowserDiagnosticField,
    getBrowserDiagnosticFieldText,
    renderBrowserDiagnosticEventDetail,
    renderPanelField,
    renderPanelMetric,
    safeEventDetail,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

const WEBSOCKET_METRIC_KEYS = [
    'framesSent',
    'framesReceived',
    'messageCount',
    'bytesSent',
    'bytesReceived',
] as const;

const OWNER_VALUE_FIELD_KEYS = [
    'requestHeaders',
    'responseHeaders',
    'requestBodyText',
    'responseBodyText',
] as const;

function firstFieldText(
    event: BrowserDiagnosticEventProjection,
    keys: readonly string[],
): string | null {
    for (const key of keys) {
        const value = getBrowserDiagnosticFieldText(event, key);
        if (value) return value;
    }
    return null;
}

function renderNetworkChrome(
    event: BrowserDiagnosticEventProjection,
    rowTestID: string,
    testID: string,
    children: React.ReactNode,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    return (
        <View key={event.eventId} testID={rowTestID} style={browserDiagnosticsPanelStyles.panelGroup}>
            <View
                testID={`${testID}-event-${eventId}`}
                style={browserDiagnosticsPanelStyles.titleRow}
            >
                <Text style={browserDiagnosticsPanelStyles.panelGroupTitle}>{eventTitle(event)}</Text>
                <BrowserDiagnosticsFidelityBadge
                    fidelity={event.fidelity}
                    testID={`${rowTestID}-fidelity-${event.fidelity}`}
                />
            </View>
            <Text testID={`${testID}-network-detail-${eventId}`} style={browserDiagnosticsPanelStyles.flowMeta}>
                {safeEventDetail(event)}
            </Text>
            {children}
            {event.detail ? renderBrowserDiagnosticEventDetail(event.detail, rowTestID) : null}
            {!event.trusted ? (
                <Text style={browserDiagnosticsPanelStyles.warning}>{t('browserDiagnostics.host.untrustedEvent')}</Text>
            ) : null}
        </View>
    );
}

function renderWebSocketEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-network-row-${eventId}`;
    const socketId = getBrowserDiagnosticField(event, 'socketId');
    const state = getBrowserDiagnosticField(event, 'state');
    const hasProtocol = getBrowserDiagnosticField(event, 'hasProtocol');
    const protocolCount = getBrowserDiagnosticField(event, 'protocolCount');

    return renderNetworkChrome(event, rowTestID, testID, (
        <View testID={`${testID}-network-websocket-${eventId}`} style={browserDiagnosticsPanelStyles.metricGrid}>
            {renderPanelMetric({
                label: fieldLabel('socketId'),
                value: socketId,
                testID: `${testID}-network-websocket-${eventId}-socket`,
            })}
            {renderPanelMetric({
                label: fieldLabel('state'),
                value: state,
                testID: `${testID}-network-websocket-${eventId}-state`,
            })}
            {typeof hasProtocol === 'boolean' || typeof protocolCount === 'number' ? renderPanelMetric({
                label: fieldLabel('protocolCount'),
                value: typeof protocolCount === 'number'
                    ? protocolCount
                    : hasProtocol,
                testID: `${testID}-network-websocket-${eventId}-protocol`,
            }) : null}
            {WEBSOCKET_METRIC_KEYS.map((key) => {
                const metric = renderPanelMetric({
                    label: fieldLabel(key),
                    value: getBrowserDiagnosticField(event, key),
                    testID: `${testID}-network-websocket-${eventId}-metric-${key}`,
                });
                return metric ? React.cloneElement(metric, { key }) : null;
            })}
        </View>
    ));
}

function renderNetworkRequestEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    const eventId = sanitizeTestIdPart(event.eventId);
    const rowTestID = `${testID}-network-row-${eventId}`;
    const method = getBrowserDiagnosticField(event, 'method') ?? (event.kind === 'network.sendBeacon' ? 'BEACON' : undefined);
    const status = getBrowserDiagnosticField(event, 'statusCode') ?? getBrowserDiagnosticField(event, 'status');
    const url = firstFieldText(event, ['url', 'path']) ?? safeEventDetail(event);
    const duration = getBrowserDiagnosticField(event, 'durationMs');
    const size = getBrowserDiagnosticField(event, 'responseBytes') ?? getBrowserDiagnosticField(event, 'requestBytes') ?? getBrowserDiagnosticField(event, 'bytesQueued');

    return renderNetworkChrome(event, rowTestID, testID, (
        <View testID={`${testID}-network-request-${eventId}`} style={browserDiagnosticsPanelStyles.panelRow}>
            {renderPanelField({
                label: fieldLabel('method'),
                value: method,
                testID: `${testID}-network-request-${eventId}-method`,
            })}
            {renderPanelField({
                label: fieldLabel('statusCode'),
                value: status,
                testID: `${testID}-network-request-${eventId}-status`,
            })}
            {renderPanelField({
                label: fieldLabel('url'),
                value: url,
                testID: `${testID}-network-request-${eventId}-url`,
                wide: true,
            })}
            {renderPanelField({
                label: fieldLabel('durationMs'),
                value: duration,
                testID: `${testID}-network-request-${eventId}-duration`,
            })}
            {renderPanelField({
                label: fieldLabel('responseBytes'),
                value: size,
                testID: `${testID}-network-request-${eventId}-size`,
            })}
            {OWNER_VALUE_FIELD_KEYS.map((key) => {
                const field = renderPanelField({
                    label: fieldLabel(key),
                    value: getBrowserDiagnosticField(event, key),
                    testID: `${testID}-network-request-${eventId}-${key}`,
                    wide: true,
                });
                return field ? React.cloneElement(field, { key }) : null;
            })}
        </View>
    ));
}

function renderNetworkEvent(
    event: BrowserDiagnosticEventProjection,
    testID: string,
): React.ReactElement {
    if (event.kind.startsWith('network.websocket')) {
        return renderWebSocketEvent(event, testID);
    }
    return renderNetworkRequestEvent(event, testID);
}

export function BrowserNetworkPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="network"
            renderEvent={renderNetworkEvent}
        />
    );
}
