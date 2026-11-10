import { FileSaveResultSchema, type FileSaveInput } from '@happier-dev/protocol/actions/actionSpecs';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();

/** UI and automation use the same answering-client file handoff Action. */
export async function requestSaveFile(input: FileSaveInput, scope?: ServerAccountScope): Promise<
    ReturnType<typeof FileSaveResultSchema.parse> | Readonly<{ status: 'failed'; errorCode: string }>
> {
    try {
        const result = await execute('files.save', input, { surface: 'ui', actionCaller: { kind: 'host' },
            ...(scope ? { serverId: scope.serverId, expectedAccountId: scope.accountId } : {}) });
        if (!result.ok) return { status: 'failed', errorCode: result.errorCode ?? 'file_save_failed' };
        const saved = FileSaveResultSchema.safeParse(result.result);
        return saved.success ? saved.data : { status: 'failed', errorCode: 'file_save_failed' };
    } catch {
        return { status: 'failed', errorCode: 'file_save_failed' };
    }
}
