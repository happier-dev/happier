import { normalizeSessionStoredMessageContentForStorage } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { warn } from "@/utils/logging/log";

/** PostgreSQL JSONB cannot represent NUL. Normalize before persistence AND idempotency checks. */
export function normalizeSessionMessageContentForStorage(
    content: PrismaJson.SessionMessageContent,
): PrismaJson.SessionMessageContent | null {
    const normalized = normalizeSessionStoredMessageContentForStorage(content);
    if (normalized && normalized !== content) {
        warn({ module: "session-message-content", event: "nul-removed" }, "Removed NUL characters from plaintext message content");
    }
    return normalized;
}
