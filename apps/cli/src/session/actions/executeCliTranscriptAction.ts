import { randomUUID } from 'node:crypto';

import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import { SessionMessageContentSchema } from '@/api/types';
import {
    DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    createSessionTranscriptFollowLeaseRegistry,
    followSessionTranscript,
    importSessionTranscript,
    pageSessionTranscript,
    readSessionTranscriptAfter,
    searchSessionTranscript,
    type SessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type {
    FileBackedTranscriptSessionStore,
} from '@/api/session/fileBackedTranscripts/store';
import {
    readOptionalString,
    readRecord,
    type SessionTranscriptActionItem,
} from '@/api/session/sessionTranscriptActionInput';
import { tailSessionLog } from '@/api/session/tailSessionLog';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { validatePath } from '@/rpc/handlers/pathSecurity';

const TRANSCRIPT_ACTION_IDS = new Set<ActionId>([
    'session.log.tail',
    'transcript.page',
    'transcript.readAfter',
    'transcript.follow',
    'transcript.import',
    'transcript.search',
]);

export type CliTranscriptActionExecutorOptions = Readonly<{
    transcriptSessionId?: string;
    transcriptStore?: FileBackedTranscriptSessionStore<SessionTranscriptActionItem>;
    resolveTranscriptStore?: (sessionId: string) => Promise<FileBackedTranscriptSessionStore<SessionTranscriptActionItem>>;
    transcriptFollowLeaseRegistry?: SessionTranscriptFollowLeaseRegistry;
    writeTranscriptItems?: (
        sessionId: string,
        items: readonly SessionTranscriptActionItem[],
    ) => Promise<Readonly<{ imported: number; cursor: string | null }>>;
    sessionLogAccess?: Readonly<{
        workingDirectory: string;
        accessPolicy: FilesystemAccessPolicy;
        getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    }>;
}>;

function readSessionId(input: Record<string, unknown>, context: ActionExecutorContext | undefined, fallback: string): string {
    return readOptionalString(input, 'sessionId')
        ?? (typeof context?.defaultSessionId === 'string' && context.defaultSessionId.trim().length > 0
            ? context.defaultSessionId.trim()
            : fallback);
}

function unsupported(actionId: ActionId, detail: string): ActionExecuteResult {
    return { ok: false, errorCode: detail, error: `${detail}:${actionId}` };
}

function stringifyTranscriptItem(item: SessionTranscriptActionItem): string {
    if (typeof item.text === 'string') {
        return item.text;
    }
    return JSON.stringify(item.raw ?? item.content ?? item);
}

function readImportOperationId(input: Record<string, unknown>): string {
    return readOptionalString(input, 'importId')
        ?? readOptionalString(input, 'operationId')
        ?? randomUUID();
}

async function resolveStore(
    params: Readonly<{
        options: CliTranscriptActionExecutorOptions;
        sessionId: string;
    }>,
): Promise<FileBackedTranscriptSessionStore<SessionTranscriptActionItem> | null> {
    if (params.options.resolveTranscriptStore) {
        return await params.options.resolveTranscriptStore(params.sessionId);
    }
    if (params.options.transcriptStore) {
        const boundSessionId = params.options.transcriptSessionId;
        if (boundSessionId && boundSessionId !== params.sessionId) {
            return null;
        }
        return params.options.transcriptStore;
    }
    return null;
}

function coerceImportItems(input: Record<string, unknown>): readonly SessionTranscriptActionItem[] {
    const rawItems = Array.isArray(input.items) ? input.items : [];
    const fallbackNamespace = readImportOperationId(input);
    return rawItems
        .map((item, index): SessionTranscriptActionItem | null => {
            const record = readRecord(item);
            const content = record.content;
            const parsedContent = SessionMessageContentSchema.safeParse(content);
            return {
                id: readOptionalString(record, 'id')
                    ?? readOptionalString(record, 'localId')
                    ?? `import:${fallbackNamespace}:${index}`,
                ...(typeof record.seq === 'number' ? { seq: record.seq } : {}),
                ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
                ...(typeof record.text === 'string' ? { text: record.text } : {}),
                ...(parsedContent.success ? { content: parsedContent.data } : {}),
                raw: item,
            };
        })
        .filter((item): item is SessionTranscriptActionItem => item !== null);
}

export async function executeCliTranscriptAction(
    params: Readonly<{
        actionId: ActionId;
        input: unknown;
        context?: ActionExecutorContext;
        defaultSessionId: string;
        options: CliTranscriptActionExecutorOptions;
    }>,
): Promise<ActionExecuteResult | null> {
    if (!TRANSCRIPT_ACTION_IDS.has(params.actionId)) {
        return null;
    }

    const input = readRecord(params.input);
    const sessionId = readSessionId(input, params.context, params.defaultSessionId);

    if (params.actionId === 'session.log.tail') {
        const path = readOptionalString(input, 'path');
        if (!path) {
            return { ok: true, result: await tailSessionLog({ input }) };
        }
        const access = params.options.sessionLogAccess;
        if (!access) {
            return unsupported(params.actionId, 'session_log_access_unavailable');
        }
        const validation = validatePath(
            path,
            access.workingDirectory,
            access.getAdditionalAllowedReadDirs?.() ?? [],
            access.accessPolicy,
        );
        if (!validation.valid || !validation.resolvedPath) {
            return {
                ok: true,
                result: {
                    ok: false,
                    errorCode: 'access_denied',
                    message: validation.error ?? 'Access denied',
                },
            };
        }
        return { ok: true, result: await tailSessionLog({ input, resolvedPath: validation.resolvedPath }) };
    }

    const store = await resolveStore({ options: params.options, sessionId });
    if (!store) {
        return unsupported(params.actionId, 'transcript_store_unavailable');
    }

    if (params.actionId === 'transcript.page') {
        return { ok: true, result: await pageSessionTranscript({ store, input }) };
    }
    if (params.actionId === 'transcript.readAfter') {
        return { ok: true, result: await readSessionTranscriptAfter({ store, input }) };
    }
    if (params.actionId === 'transcript.follow') {
        const registry = params.options.transcriptFollowLeaseRegistry
            ?? createSessionTranscriptFollowLeaseRegistry({
                maxLeases: 16,
                idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
            });
        const result = await followSessionTranscript({ store, registry, input });
        if (!result.ok) {
            return {
                ok: false,
                errorCode: result.errorCode,
                error: result.message,
            };
        }
        return { ok: true, result };
    }
    if (params.actionId === 'transcript.search') {
        return {
            ok: true,
            result: await searchSessionTranscript({
                store,
                input,
                stringifyItem: stringifyTranscriptItem,
            }),
        };
    }
    if (params.actionId === 'transcript.import') {
        const writeTranscriptItems = params.options.writeTranscriptItems;
        if (!writeTranscriptItems) {
            return unsupported(params.actionId, 'transcript_import_unavailable');
        }
        return {
            ok: true,
            result: await importSessionTranscript<SessionTranscriptActionItem>({
                input: {
                    ...input,
                    items: coerceImportItems(input),
                },
                writeItems: (items) => writeTranscriptItems(sessionId, items),
            }),
        };
    }

    return unsupported(params.actionId, 'unsupported_action');
}
