import * as React from 'react';
import { View } from 'react-native';

import {
    selectBrowserDiagnosticRequests,
    type BrowserDiagnosticEventProjection,
    type BrowserDiagnosticRequestProjection,
} from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    browserDiagnosticsPanelStyles,
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsCodeBlock,
    DiagnosticsColumnHeader,
    DiagnosticsFieldList,
    DiagnosticsRow,
    type BrowserDiagnosticsFamilyPanelProps,
    type DiagnosticsField,
    fieldLabel,
    formatBrowserDiagnosticFieldValue,
    formatBytes,
    formatDurationMs,
    getBrowserDiagnosticString,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';
import { BrowserNetworkRequestExtras } from './BrowserNetworkRequestExtras';

/**
 * One row per request. Pairing (start, response, finish, failure by `requestId` or socket id) and
 * filtering belong to the store's `selectBrowserDiagnosticRequests`; this panel only draws them.
 */
type NetworkRequest = BrowserDiagnosticRequestProjection;

function lastValue<T>(events: readonly BrowserDiagnosticEventProjection[], read: (event: BrowserDiagnosticEventProjection) => T | null): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const value = read(events[index]!);
        if (value !== null) return value;
    }
    return null;
}


/** The path a developer scans for; the full URL is in the detail. */
function displayPath(url: string | null): string | null {
    if (!url) return null;
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(url);
    return match ? (match[1] ?? '/') : url;
}

function leadLabel(request: NetworkRequest): string {
    if (request.kind === 'socket') return 'WS';
    if (request.kind === 'beacon') return 'BEACON';
    return request.method ?? '—';
}

function statusText(request: NetworkRequest): string {
    if (request.failed) return t('browserDiagnostics.host.devtools.network.failed');
    if (request.status !== null) return String(request.status);
    if (request.kind === 'socket') return request.state ?? '—';
    return '…';
}

/** What the row cannot show: the full address, the failure, the type; the row already carries method, status, time and size. */
function requestFields(request: NetworkRequest): DiagnosticsField[] {
    const fields: DiagnosticsField[] = [];
    const push = (key: string, value: string | null, options: Readonly<{ mono?: boolean; copy?: boolean }> = {}) => {
        const label = fieldLabel(key);
        if (value && label) fields.push({ key, label, value, ...options });
    };
    push('url', request.url, { mono: true, copy: true });
    if (request.failed) push('errorText', request.errorText ?? t('browserDiagnostics.host.devtools.network.failedNoReason'));
    push('resourceType', request.type);
    const seen = new Set([...CODE_BLOCK_KEYS, 'requestBodyTruncated', 'responseBodyTruncated', 'url', 'path', 'method', 'status', 'statusCode', 'resourceType', 'durationMs', 'responseBytes', 'encodedDataLength', 'bytesQueued', 'errorText', 'requestId']);
    for (const event of request.events) {
        for (const field of event.detail?.fields ?? []) {
            if (seen.has(field.key)) continue;
            const label = fieldLabel(field.key);
            if (!label) continue;
            seen.add(field.key);
            const mono = field.key === 'mimeType';
            fields.push({ key: field.key, label, value: formatBrowserDiagnosticFieldValue(field.value), mono });
        }
    }
    return fields;
}

/** Headers and bodies read as text blocks, not table cells; bodies appear when the owner admitted them. */
const CODE_BLOCK_KEYS = ['requestHeaders', 'responseHeaders', 'requestBodyText', 'responseBodyText'] as const;

function RequestDetail(props: Readonly<{ request: NetworkRequest; testID: string }>): React.ReactElement {
    const fields = requestFields(props.request);
    const blocks = CODE_BLOCK_KEYS.flatMap((key) => {
        const text = lastValue(props.request.events, (event) => getBrowserDiagnosticString(event, key));
        if (!text) return [];
        const truncatedKey = key === 'requestBodyText' ? 'requestBodyTruncated' : key === 'responseBodyText' ? 'responseBodyTruncated' : null;
        const truncated = truncatedKey
            ? props.request.events.some((event) => event.detail?.fields.some((field) => field.key === truncatedKey && field.value === true))
            : false;
        return [{ key, text, truncated }];
    });
    return (
        <View testID={props.testID} style={browserDiagnosticsPanelStyles.detail}>
            <DiagnosticsFieldList variant="plain" fields={fields} testID={`${props.testID}-fields`} />
            {blocks.map((block) => (
                <DiagnosticsCodeBlock
                    key={block.key}
                    testID={`${props.testID}-${block.key}`}
                    label={fieldLabel(block.key) ?? block.key}
                    text={block.text}
                    truncated={block.truncated}
                />
            ))}
            {props.request.kind === 'http' ? (
                <BrowserNetworkRequestExtras requestId={props.request.requestId} testID={props.testID} />
            ) : null}
        </View>
    );
}

function renderNetworkRows(requests: readonly NetworkRequest[], testID: string): React.ReactNode {
    return (
        <>
            <DiagnosticsColumnHeader
                testID={`${testID}-network-columns`}
                lead={fieldLabel('method') ?? ''}
                subject={fieldLabel('url') ?? ''}
                meta={[
                    fieldLabel('status') ?? '',
                    fieldLabel('durationMs') ?? '',
                    t('browserDiagnostics.host.devtools.network.size'),
                ]}
            />
            {requests.map((request) => {
                const rowTestID = `${testID}-network-row-${sanitizeTestIdPart(request.events[0]?.eventId ?? request.key)}`;
                const failure = request.isFailure;
                return (
                    <DiagnosticsRow
                        key={request.key}
                        testID={rowTestID}
                        tone={failure ? 'danger' : 'neutral'}
                        lead={leadLabel(request)}
                        subject={displayPath(request.url) ?? (request.kind === 'socket' ? lastValue(request.events, (event) => getBrowserDiagnosticString(event, 'socketId') ?? getBrowserDiagnosticString(event, 'sourceId')) : null) ?? request.events[0]?.summary ?? t('browserDiagnostics.host.devtools.network.noUrl')}
                        subjectMuted={!request.url && !request.events[0]?.summary}
                        meta={[
                            { text: statusText(request), tone: failure ? 'danger' : undefined },
                            request.durationMs !== null ? { text: formatDurationMs(request.durationMs) } : null,
                            request.sizeBytes !== null ? { text: formatBytes(request.sizeBytes) } : null,
                        ]}
                        renderDetail={() => <RequestDetail request={request} testID={`${rowTestID}-detail`} />}
                    />
                );
            })}
        </>
    );
}

export function BrowserNetworkPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const events = props.events;
    const requests = React.useMemo(() => selectBrowserDiagnosticRequests({ events }), [events]);
    const selectItems = React.useCallback(
        (segment: string, query: string) => selectBrowserDiagnosticRequests({ events }, { failedOnly: segment === 'failed', search: query }),
        [events],
    );
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="network"
            items={requests}
            countLabel={(count) => t('browserDiagnostics.host.devtools.count.requests', { count })}
            segments={[
                { id: 'all', label: t('browserDiagnostics.host.devtools.filter.all') },
                { id: 'failed', label: t('browserDiagnostics.host.devtools.filter.failed') },
            ]}
            searchPlaceholder={t('browserDiagnostics.host.devtools.search.network')}
            selectItems={selectItems}
            renderItems={(visible) => renderNetworkRows(visible, props.testID)}
        />
    );
}
