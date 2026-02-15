import { sessionEphemeralTaskRun } from '@/sync/ops/sessionEphemeralTasks';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

export type ScmCommitMessageGeneratorResult =
    | { ok: true; message: string }
    | { ok: false; error: string; errorCode?: string };

export async function generateScmCommitMessage(params: Readonly<{
    sessionId: string;
    backendId: string;
    instructions?: string;
    scopePaths?: ReadonlyArray<string>;
}>): Promise<ScmCommitMessageGeneratorResult> {
    const backendId = typeof params.backendId === 'string' ? params.backendId.trim() : '';
    if (!backendId) {
        return { ok: false, error: 'Missing backend id' };
    }

    const include = (params.scopePaths ?? [])
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0);

    const serverId = resolveServerIdForSessionIdFromLocalCache(params.sessionId);
    const res = await sessionEphemeralTaskRun(
        params.sessionId,
        {
            kind: 'scm.commit_message',
            sessionId: params.sessionId,
            input: {
                backendId,
                ...(typeof params.instructions === 'string' && params.instructions.trim().length > 0
                    ? { instructions: params.instructions.trim() }
                    : {}),
                scope: { kind: 'paths', include },
            },
            // Hard-safety: commit generation must not be tool-capable by default.
            permissionMode: 'no_tools',
        },
        { serverId },
    );

    if (!res.ok) {
        const rawError: unknown = (res as any).error;
        const message =
            typeof rawError === 'string'
                ? rawError
                : rawError && typeof rawError === 'object' && typeof (rawError as any).message === 'string'
                    ? String((rawError as any).message)
                    : 'Commit message generation failed';
        const errorCode =
            typeof (res as any).errorCode === 'string'
                ? String((res as any).errorCode)
                : rawError && typeof rawError === 'object' && typeof (rawError as any).code === 'string'
                    ? String((rawError as any).code)
                    : undefined;
        return { ok: false, error: message, ...(errorCode ? { errorCode } : {}) };
    }

    const result: any = (res as any).result ?? null;
    const message = result && typeof result === 'object' ? (result as any).message : null;
    const normalized = typeof message === 'string' ? message.trim() : '';
    if (!normalized) {
        return { ok: false, error: 'Empty commit message suggestion' };
    }

    return { ok: true, message: normalized };
}
