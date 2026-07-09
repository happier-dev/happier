import * as React from 'react';
import { View } from 'react-native';

import { PluginStructuredMessageRendererIdV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginStructuredMessageRendererIdV1 } from '@happier-dev/protocol/plugins/ui';

import { Text } from '@/components/ui/text/Text';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import type { PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';

/**
 * Single source of truth for the host structured-message renderer-id allowlist:
 * the canonical protocol enum. The host renderer map and the membership check
 * both derive from this, so adding a renderer id protocol-side cannot silently
 * drift the UI (the closure test pins set-equality).
 */
export type PluginStructuredMessageRendererId = PluginStructuredMessageRendererIdV1;

const HOST_STRUCTURED_MESSAGE_RENDERER_ID_SET: ReadonlySet<string> = new Set(
    PluginStructuredMessageRendererIdV1Schema.options,
);

type UnknownRecord = Readonly<Record<string, unknown>>;
type HostStructuredMessageRenderer = (payload: unknown) => React.ReactElement;

const MAX_TEXT_LENGTH = 1_000;
const MAX_LIST_ITEMS = 12;

function readRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function readRecordArray(value: unknown): readonly UnknownRecord[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(readRecord)
        .filter((entry): entry is UnknownRecord => entry !== null)
        .slice(0, MAX_LIST_ITEMS);
}

function readDisplayText(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return null;
    }
    const text = String(value).trim();
    if (!text) return null;
    return text.length > MAX_TEXT_LENGTH
        ? `${text.slice(0, MAX_TEXT_LENGTH)}...`
        : text;
}

function readTextField(record: UnknownRecord | null, key: string): string | null {
    return readDisplayText(record?.[key]);
}

function readHostRendererId(
    descriptor: PluginUiStructuredMessageProjection,
): PluginStructuredMessageRendererId | null {
    const renderer = descriptor.renderer;
    if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) {
        return null;
    }
    if ((renderer as { kind?: unknown }).kind !== 'host') {
        return null;
    }
    const rendererId = (renderer as { rendererId?: unknown }).rendererId;
    if (typeof rendererId === 'string' && HOST_STRUCTURED_MESSAGE_RENDERER_ID_SET.has(rendererId)) {
        return rendererId as PluginStructuredMessageRendererId;
    }
    return null;
}

function renderText(value: string | null, testID?: string): React.ReactElement | null {
    if (!value) return null;
    return <Text testID={testID}>{value}</Text>;
}

function renderRendererShell(
    rendererId: PluginStructuredMessageRendererId,
    children: React.ReactNode,
): React.ReactElement {
    return (
        <View
            testID={`plugin-structured-message-${rendererId}`}
            style={{ minWidth: 0 }}
        >
            {children}
        </View>
    );
}

function renderActionList(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    const actions = readRecordArray(record?.actions);
    return renderRendererShell('actionList', (
        <>
            {renderText(readTextField(record, 'title'), 'plugin-structured-message-title')}
            {actions.map((action, index) => (
                <View key={index} testID={`plugin-structured-message-action-${index}`}>
                    {renderText(readTextField(action, 'label') ?? readTextField(action, 'id'))}
                    {renderText(readTextField(action, 'status'))}
                </View>
            ))}
        </>
    ));
}

function renderKeyValue(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    const items = readRecordArray(record?.items);
    return renderRendererShell('keyValue', (
        <>
            {renderText(readTextField(record, 'title'), 'plugin-structured-message-title')}
            {items.map((item, index) => (
                <View key={index} testID={`plugin-structured-message-key-value-row-${index}`}>
                    {renderText(readTextField(item, 'key') ?? readTextField(item, 'label'))}
                    {renderText(readTextField(item, 'value'))}
                </View>
            ))}
        </>
    ));
}

function renderMarkdownSummary(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    return renderRendererShell('markdownSummary', (
        <>
            {renderText(readTextField(record, 'title'), 'plugin-structured-message-title')}
            {renderText(readTextField(record, 'markdown') ?? readTextField(record, 'summary'), 'plugin-structured-message-markdown-summary')}
        </>
    ));
}

function renderNotice(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    return renderRendererShell('notice', (
        <>
            {renderText(readTextField(record, 'title'), 'plugin-structured-message-title')}
            {renderText(readTextField(record, 'message') ?? readTextField(record, 'summary'), 'plugin-structured-message-notice-message')}
            {renderText(readTextField(record, 'severity'), 'plugin-structured-message-notice-severity')}
        </>
    ));
}

function renderResourceLink(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    return renderRendererShell('resourceLink', (
        <View testID="plugin-structured-message-resource-link">
            {renderText(readTextField(record, 'label') ?? readTextField(record, 'title'))}
            {renderText(readTextField(record, 'url') ?? readTextField(record, 'href'))}
        </View>
    ));
}

function renderStatus(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    return renderRendererShell('status', (
        <>
            {renderText(readTextField(record, 'label') ?? readTextField(record, 'title'), 'plugin-structured-message-status-label')}
            {renderText(readTextField(record, 'status'), 'plugin-structured-message-status-value')}
            {renderText(readTextField(record, 'detail') ?? readTextField(record, 'summary'), 'plugin-structured-message-status-detail')}
        </>
    ));
}

function renderSummaryCard(payload: unknown): React.ReactElement {
    const record = readRecord(payload);
    return renderRendererShell('summaryCard', (
        <>
            {renderText(readTextField(record, 'title'), 'plugin-structured-message-title')}
            {renderText(readTextField(record, 'summary') ?? readTextField(record, 'description'), 'plugin-structured-message-summary')}
        </>
    ));
}

const HOST_STRUCTURED_MESSAGE_RENDERERS: Readonly<Record<PluginStructuredMessageRendererId, HostStructuredMessageRenderer>> = Object.freeze({
    actionList: renderActionList,
    keyValue: renderKeyValue,
    markdownSummary: renderMarkdownSummary,
    notice: renderNotice,
    resourceLink: renderResourceLink,
    status: renderStatus,
    summaryCard: renderSummaryCard,
});

export const HOST_STRUCTURED_MESSAGE_RENDERER_IDS: readonly PluginStructuredMessageRendererId[] =
    Object.freeze(Object.keys(HOST_STRUCTURED_MESSAGE_RENDERERS) as PluginStructuredMessageRendererId[]);

export function renderPluginStructuredMessage(params: Readonly<{
    descriptor: PluginUiStructuredMessageProjection;
    payload: unknown;
}>): React.ReactElement | null {
    const rendererId = readHostRendererId(params.descriptor);
    if (!rendererId) {
        return <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }

    return HOST_STRUCTURED_MESSAGE_RENDERERS[rendererId](params.payload);
}
