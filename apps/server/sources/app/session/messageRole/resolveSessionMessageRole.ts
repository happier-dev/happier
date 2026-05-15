import { SessionMessageRoleSchema, type SessionMessageRole } from "@happier-dev/protocol";
import { sessionMessageRoleMismatchCounter } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { warn } from "@/utils/logging/log";

type SessionMessageRoleContent = PrismaJson.SessionMessageContent | PrismaJson.SessionPendingMessageContent;

export type SessionMessageRoleMismatch = Readonly<{
    suppliedRole: SessionMessageRole;
    derivedRole: SessionMessageRole;
    finalRole: SessionMessageRole;
    contentKind: "encrypted" | "plain";
    storageMode: "e2ee" | "plain" | "unknown";
    source: "session-message" | "pending-message" | "pending-materialization";
}>;

export type ResolveSessionMessageRoleResult = Readonly<{
    messageRole: SessionMessageRole | null;
    mismatch: SessionMessageRoleMismatch | null;
}>;

export function parseSessionMessageRole(value: unknown): SessionMessageRole | null {
    const parsed = SessionMessageRoleSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function derivePlainMessageRole(content: SessionMessageRoleContent): SessionMessageRole | null {
    if (content.t !== "plain" || !content.v || typeof content.v !== "object" || Array.isArray(content.v)) {
        return null;
    }

    const record = content.v as Record<string, unknown>;
    return parseSessionMessageRole(record.role) ?? parseSessionMessageRole(record.type);
}

function recordRoleMismatch(sessionId: string | null, mismatch: SessionMessageRoleMismatch): void {
    sessionMessageRoleMismatchCounter.inc({
        supplied_role: mismatch.suppliedRole,
        derived_role: mismatch.derivedRole,
        final_role: mismatch.finalRole,
        content_kind: mismatch.contentKind,
        storage_mode: mismatch.storageMode,
        source: mismatch.source,
    });
    warn(
        {
            module: "session-message-role",
            event: "session_message_role_mismatch",
            ...(sessionId ? { sessionId } : {}),
            suppliedRole: mismatch.suppliedRole,
            derivedRole: mismatch.derivedRole,
            finalRole: mismatch.finalRole,
            contentKind: mismatch.contentKind,
            storageMode: mismatch.storageMode,
            source: mismatch.source,
        },
        "Session message role mismatch",
    );
}

export function resolveSessionMessageRole(input: Readonly<{
    content: SessionMessageRoleContent;
    suppliedRole?: unknown;
    telemetry?: Readonly<{
        sessionId?: string | null;
        storageMode?: "e2ee" | "plain" | "unknown";
        source: SessionMessageRoleMismatch["source"];
    }>;
}>): ResolveSessionMessageRoleResult {
    const suppliedRole = parseSessionMessageRole(input.suppliedRole);
    const derivedRole = derivePlainMessageRole(input.content);
    const messageRole = suppliedRole ?? derivedRole;

    if (suppliedRole !== null && derivedRole !== null && suppliedRole !== derivedRole) {
        const mismatch = {
            suppliedRole,
            derivedRole,
            finalRole: suppliedRole,
            contentKind: input.content.t,
            storageMode: input.telemetry?.storageMode ?? "unknown",
            source: input.telemetry?.source ?? "session-message",
        } satisfies SessionMessageRoleMismatch;
        recordRoleMismatch(input.telemetry?.sessionId ?? null, mismatch);
        return { messageRole, mismatch };
    }

    return {
        messageRole,
        mismatch: null,
    };
}
