import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    parseSessionMediaMessageMeta,
    type SessionMediaInlineImageSummary,
} from './sessionMediaMessageMeta';

export type SessionMediaGalleryItem = Readonly<{
    /** Stable per-file key: a file referenced again later is listed once, at its first message. */
    key: string;
    media: SessionMediaInlineImageSummary;
    /** Message the media first appeared in; the target of "jump to message". */
    messageId: string;
    seq: number | null;
    createdAt: number;
}>;

/**
 * Session-wide media listing: the same per-message parse the transcript uses
 * (`parseSessionMediaMessageMeta`), gathered across the session, newest first.
 * Tool-call results carry their media on the tool-call message or its children.
 */
export function collectSessionMediaItems(messages: readonly Message[]): readonly SessionMediaGalleryItem[] {
    const byKey = new Map<string, SessionMediaGalleryItem>();

    const visit = (message: Message, owner: Message) => {
        for (const media of parseSessionMediaMessageMeta(message.meta).inlineImages) {
            const key = `${media.sha256 ?? ''}:${media.path}`;
            if (byKey.has(key)) continue;
            byKey.set(key, {
                key,
                media,
                messageId: owner.id,
                seq: typeof owner.seq === 'number' ? owner.seq : null,
                createdAt: owner.createdAt,
            });
        }
        if (message.kind === 'tool-call') {
            for (const child of message.children) visit(child, owner);
        }
    };

    // Oldest first so the first sighting of a file is its originating message.
    const oldestFirst = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    for (const message of oldestFirst) visit(message, message);

    return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
}
