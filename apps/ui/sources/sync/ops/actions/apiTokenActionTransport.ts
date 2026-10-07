import { ExternalActionRequestEnvelopeV1Schema, parseExternalActionResponseEnvelopeV1, type ExternalActionTargetV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, projectSessionSpawnNewApiRequest } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ServerFetch } from '@/sync/http/client';
import type { z } from 'zod';
export type ApiTokenActionTransport = Readonly<{ request: ServerFetch; target?: ExternalActionTargetV1 }>;
export async function executeApiTokenAction(transport: ApiTokenActionTransport, actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult> {
    const refused = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
    const publicId = PublicActionIdSchema.safeParse(actionId);
    if (!publicId.success) return refused('unsupported_action');
    let body: unknown;
    try {
        const projection = actionId === 'session.spawn_new' ? projectSessionSpawnNewApiRequest(input) : { input, target: transport.target };
        const validatedInput = PUBLIC_ACTION_INPUT_SCHEMAS[publicId.data].parse(projection.input);
        body = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, input: validatedInput, ...(projection.target ? { target: projection.target } : {}) });
    } catch { return refused('invalid_parameters'); }
    context?.signal?.throwIfAborted();
    const response = await transport.request(`/v1/actions/${encodeURIComponent(actionId)}`, {
        method: 'POST', signal: context?.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }, { retry: 'none' });
    let raw: unknown;
    try { raw = await response.json(); } catch { return refused('invalid_action_output'); }
    const parsed = parseExternalActionResponseEnvelopeV1(raw);
    if (!parsed || parsed.actionId !== actionId || parsed.requestId !== undefined) return refused('invalid_action_output');
    if (!parsed.execution.ok) return parsed.execution;
    // This generic transport returns unknown; each Action's schema still validates its payload.
    const outputSchema: z.ZodType<unknown> = PUBLIC_ACTION_OUTPUT_SCHEMAS[publicId.data];
    const output = outputSchema.safeParse(parsed.execution.result);
    return output.success ? { ok: true, result: output.data } : refused('invalid_action_output');
}
