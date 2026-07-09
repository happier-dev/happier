import React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';
import type { StructuredMessageRendererParams } from './structuredMessageRegistry';
import { findStructuredMessageDescriptorEntry } from './descriptorRegistry';

const NON_STRUCTURED_HAPPIER_META_KINDS = new Set([
    'attachments.v1',
    'session_media.v1',
]);

export function renderStructuredMessage(params: {
    message: Message;
    sessionId: string;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    pluginUiProjection?: PluginUiProjectionModel | null;
}): React.ReactElement | null {
    const envelope = parseHappierMetaEnvelope(params.message.meta);
    if (!envelope) return null;
    if (NON_STRUCTURED_HAPPIER_META_KINDS.has(envelope.kind)) return null;

    const entry = findStructuredMessageDescriptorEntry({
        kind: envelope.kind,
        pluginUiProjection: params.pluginUiProjection,
    });
    if (!entry) {
        return <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }

    const parsed = entry.schema.safeParse(envelope.payload);
    if (!parsed.success) {
        return <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }

    return entry.render(parsed.data, {
        sessionId: params.sessionId,
        message: params.message,
        onJumpToAnchor: params.onJumpToAnchor,
    });
}

export const StructuredMessageBlock = React.memo(function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    pluginUiProjection?: PluginUiProjectionModel | null;
}): React.ReactElement | null {
    return renderStructuredMessage(props);
});
