import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

export type SessionInstructionsTarget = Readonly<{
    sessionId: string;
    serverId: string;
    expectedMetadataRevision: number;
}>;

export type SessionInstructionsAuthoringDraft = Readonly<{ title: string; markdown: string }>;
export type SessionInstructionsAuthoringResult = Readonly<{
    result: ActionExecuteResult;
    createdRef: PromptDocArtifactRefV1 | null;
    /** The caller retains its draft until the attachment result is accepted. */
    draft: SessionInstructionsAuthoringDraft;
}>;

/** Device-local unsaved authoring recovers only the two known editor fields. */
export function readSessionInstructionsAuthoringDraft(value: unknown): SessionInstructionsAuthoringDraft | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const title: unknown = Reflect.get(value, 'title');
    const markdown: unknown = Reflect.get(value, 'markdown');
    return typeof title === 'string' && typeof markdown === 'string' ? { title, markdown } : undefined;
}

async function createWithExecutor(
    executor: ReturnType<typeof import('@/sync/ops/actions/defaultActionExecutor')['createDefaultActionExecutor']>,
    context: UiActionExecutorContext & Readonly<{ serverId: string }>,
    draft: SessionInstructionsAuthoringDraft,
): Promise<SessionInstructionsAuthoringResult> {
    const created = await executor.execute('prompt_doc.create', draft, context);
    if (!created.ok || ActionApprovalRequestCreatedResultSchema.safeParse(created.result).success)
        return { result: created, createdRef: null, draft };
    const output: unknown = getActionSpec('prompt_doc.create').outputSchema?.parse(created.result);
    const ref = PromptDocArtifactRefV1Schema.parse({ kind: 'doc', serverId: context.serverId,
        artifactId: output && typeof output === 'object' && 'artifactId' in output ? output.artifactId : undefined });
    return { result: created, createdRef: ref, draft };
}

async function create(serverId: string, draft: SessionInstructionsAuthoringDraft,
    signal?: AbortSignal, expectedAccountId?: string): Promise<SessionInstructionsAuthoringResult> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    return createWithExecutor(createDefaultActionExecutor(), {
        serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}),
        ...(expectedAccountId !== undefined ? { expectedAccountId } : {}),
    }, draft);
}

async function set(target: SessionInstructionsTarget, ref: PromptDocArtifactRefV1 | null, signal?: AbortSignal): Promise<ActionExecuteResult> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    return createDefaultActionExecutor().execute('session.instructions.set', { ...target, ref }, {
        serverId: target.serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}),
    });
}

async function createAndAttach(target: SessionInstructionsTarget, draft: SessionInstructionsAuthoringDraft,
    signal?: AbortSignal): Promise<SessionInstructionsAuthoringResult> {
    // Validate the exact reviewed Session target before creating a reusable document.
    getActionSpec('session.instructions.set').inputSchema.parse({ ...target, ref: null });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    const context = { serverId: target.serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}) } as const;
    const created = await createWithExecutor(executor, context, draft);
    if (!created.createdRef) return created;
    const ref = created.createdRef;
    // A conflict or an unknown attachment outcome keeps the created document reusable.
    const result = await executor.execute('session.instructions.set', { ...target, ref }, context);
    return { result, createdRef: ref, draft };
}

/** Work and authoring share the public Actions, never a metadata or Artifact writer. */
export const sessionInstructionsActions = { set, create, createAndAttach };
