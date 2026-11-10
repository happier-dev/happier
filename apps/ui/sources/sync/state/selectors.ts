import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from '@happier-dev/session-core/messages';
import { prepareTranscriptMessageBody, readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { projectMarkdownFindText } from '@/components/markdown/rendering/markdownFindProjection';
import { t } from '@/text';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';

type SessionMetadataCarrier = Readonly<{
    metadata?: unknown;
    lockedDisplayTitle?: unknown;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function normalizeTransientTitleText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = readableMessageText(value).trim().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : null;
}

export function formatSessionFirstMessageTitle(text: string, voice: boolean): string | null {
    const title = normalizeTransientTitleText(projectMarkdownFindText(text).text);
    if (!title || !voice || title !== title.toLocaleUpperCase() || title === title.toLocaleLowerCase()) return title;
    return title.charAt(0).toLocaleUpperCase() + title.slice(1).toLocaleLowerCase();
}

function readFirstUserMessageTitle(messages: ReadonlyArray<Message> | undefined): string | null {
    if (!messages) return null;
    for (const message of messages) {
        if (message.kind !== 'user-text') continue;
        const text = prepareTranscriptMessageBody(message).text;
        return text === null ? null : formatSessionFirstMessageTitle(text,
            readConversationTurnOriginV1FromMessageMeta(message.meta)?.channel === 'realtime_conversation');
    }
    return null;
}

export function readSessionDisplayTitleField(
    session: SessionMetadataCarrier | null | undefined,
    transient?: Readonly<{ messages?: ReadonlyArray<Message>; fallbackTitle?: string | null }>,
): Readonly<{
    value: string | null;
    updatedAt: number | null;
}> {
    const metadata = asRecord(session?.metadata);
    const summary = asRecord(metadata?.summary);
    const rawValue = typeof summary?.text === 'string' ? summary.text.trim() : '';
    const rawRenderableValue = rawValue.length > 0
        ? rawValue
        : typeof metadata?.summaryText === 'string'
            ? metadata.summaryText.trim()
            : typeof session?.lockedDisplayTitle === 'string'
                ? session.lockedDisplayTitle.trim()
                : '';
    // Historical executable Voice conversations used an implementation label as
    // their title. Present it through the same title owner as every Session;
    // authored names and summaries keep their existing precedence and spelling.
    const legacyVoiceTitle = 'Voice conversation (system)';
    const presentedValue = rawRenderableValue === legacyVoiceTitle
        || (!rawRenderableValue && normalizeTransientTitleText(metadata?.name) === legacyVoiceTitle)
        ? t('voicePresence.title') : rawRenderableValue;
    return {
        // A transient prompt title never replaces an explicit name or revives unreadable metadata.
        // A fallback title is an already projected readable title: keep it as written.
        value: (presentedValue ? readableMessageText(presentedValue) : null) || (metadata && !normalizeTransientTitleText(metadata.name)
            ? readFirstUserMessageTitle(transient?.messages) ?? (transient?.fallbackTitle?.trim() || null)
            : null),
        updatedAt: typeof summary?.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
            ? summary.updatedAt
            : null,
    };
}

export function readSessionPermissionModeField(session: Session | null | undefined): Readonly<{
    value: Session['permissionMode'] | null;
    updatedAt: number | null;
}> {
    return {
        value: session?.permissionMode ?? null,
        updatedAt: typeof session?.permissionModeUpdatedAt === 'number' ? session.permissionModeUpdatedAt : null,
    };
}

export function readSessionModelModeField(session: Session | null | undefined): Readonly<{
    value: Session['modelMode'] | null;
    updatedAt: number | null;
}> {
    return {
        value: session?.modelMode ?? null,
        updatedAt: typeof session?.modelModeUpdatedAt === 'number' ? session.modelModeUpdatedAt : null,
    };
}
