import React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';
import { findStructuredMessageRenderer, type StructuredMessageRendererParams } from './structuredMessageRegistry';

export function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
}): React.ReactElement | null {
    const envelope = parseHappierMetaEnvelope(props.message.meta);
    if (!envelope) return null;

    const entry = findStructuredMessageRenderer(envelope.kind);
    if (!entry) return null;

    const parsed = entry.schema.safeParse(envelope.payload);
    if (!parsed.success) return null;

    return entry.render(parsed.data, { sessionId: props.sessionId, onJumpToAnchor: props.onJumpToAnchor });
}
