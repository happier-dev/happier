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

// A message's media never changes while its object is the same, so each message is parsed once and
// each gallery record is reused for as long as its message is: a new arrival only costs its own parse.
const mediaByMessage = new WeakMap<Message, readonly SessionMediaInlineImageSummary[]>();
const itemByMedia = new WeakMap<SessionMediaInlineImageSummary, SessionMediaGalleryItem>();

function readMessageMedia(message: Message): readonly SessionMediaInlineImageSummary[] {
    let media = mediaByMessage.get(message);
    if (!media) {
        media = parseSessionMediaMessageMeta(message.meta).inlineImages;
        mediaByMessage.set(message, media);
    }
    return media;
}

function readGalleryItem(media: SessionMediaInlineImageSummary, owner: Message): SessionMediaGalleryItem {
    const seq = typeof owner.seq === 'number' ? owner.seq : null;
    const cached = itemByMedia.get(media);
    if (cached && cached.messageId === owner.id && cached.seq === seq && cached.createdAt === owner.createdAt) {
        return cached;
    }
    const item: SessionMediaGalleryItem = {
        key: `${media.sha256 ?? ''}:${media.path}`,
        media,
        messageId: owner.id,
        seq,
        createdAt: owner.createdAt,
    };
    itemByMedia.set(media, item);
    return item;
}

// One file reference, with or without a checksum, is one tile; different checksums at one path
// (a regenerated file) stay separate.
function isSameFile(a: SessionMediaInlineImageSummary, b: SessionMediaInlineImageSummary): boolean {
    return a.path === b.path && (!a.sha256 || !b.sha256 || a.sha256 === b.sha256);
}

/**
 * Session-wide media listing: the same per-message parse the transcript uses
 * (`parseSessionMediaMessageMeta`), gathered across the session, newest first.
 * Tool-call results carry their media on the tool-call message or its children.
 */
export function collectSessionMediaItems(messages: readonly Message[]): readonly SessionMediaGalleryItem[] {
    const itemsByPath = new Map<string, SessionMediaGalleryItem[]>();
    const oldestFirstItems: SessionMediaGalleryItem[] = [];

    const visit = (message: Message, owner: Message) => {
        for (const media of readMessageMedia(message)) {
            const sameFile = itemsByPath.get(media.path);
            if (sameFile?.some((existing) => isSameFile(existing.media, media))) continue;
            const item = readGalleryItem(media, owner);
            if (sameFile) sameFile.push(item); else itemsByPath.set(media.path, [item]);
            oldestFirstItems.push(item);
        }
        if (message.kind === 'tool-call') {
            for (const child of message.children) visit(child, owner);
        }
    };

    // The transcript is already oldest first; only sort when it is not.
    const isOrdered = messages.every((message, index) => index === 0 || messages[index - 1]!.createdAt <= message.createdAt);
    const oldestFirst = isOrdered ? messages : [...messages].sort((a, b) => a.createdAt - b.createdAt);
    for (const message of oldestFirst) visit(message, message);

    return oldestFirstItems.reverse();
}
