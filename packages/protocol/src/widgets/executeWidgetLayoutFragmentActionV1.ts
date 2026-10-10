import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { WidgetLayoutFragmentActionInputSchemasV1, WidgetLayoutFragmentActionOutputSchemasV1,
    type WidgetLayoutFragmentActionDepsV1, type WidgetLayoutFragmentActionIdV1 } from './fragmentActionsV1.js';
import { WidgetLayoutFragmentV1Schema } from './widgetLayoutFragmentV1.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';
import { resolveWidgetDefinitionAuthorV1 } from './executeWidgetDefinitionActionV1.js';

const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
export async function executeWidgetLayoutFragmentActionV1(deps: WidgetLayoutFragmentActionDepsV1,
    actionId: WidgetLayoutFragmentActionIdV1, rawInput: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult> {
    const parsed = WidgetLayoutFragmentActionInputSchemasV1[actionId].safeParse(rawInput);
    if (!parsed.success) return failure('invalid_input');
    const input = parsed.data;
    const refused = await admitWidgetActionSurfaceV1(deps, { ...input.account, owner: { kind: 'home' } }, context);
    if (refused) return refused;
    const port = deps.widgetLayoutFragmentArtifacts;
    if (!port) return failure('widget_fragment_unavailable');
    const accept = (value: unknown): ActionExecuteResult => {
        const result = WidgetLayoutFragmentActionOutputSchemasV1[actionId].safeParse(value);
        return result.success ? { ok: true, result: result.data } : failure('widget_fragment_ack_unknown');
    };
    try {
        switch (actionId) {
            case 'widgets.fragment.list': return accept({ fragments: await port.list(context.signal) });
            case 'widgets.fragment.get': {
                const args = WidgetLayoutFragmentActionInputSchemasV1[actionId].parse(input);
                const fragment = await port.get(args.artifactId, context.signal);
                return fragment ? accept({ fragment }) : failure('widget_fragment_not_found');
            }
            case 'widgets.fragment.create': {
                const args = WidgetLayoutFragmentActionInputSchemasV1[actionId].parse(input);
                return accept({ fragment: await port.create(WidgetLayoutFragmentV1Schema.parse({ v: 1, id: args.artifactId,
                    ...args.fragment, provenance: { authorAccountId: input.account.accountId, author: resolveWidgetDefinitionAuthorV1(context),
                        createdAt: Date.now(), source: { kind: 'authored' } } }), context.signal) });
            }
            case 'widgets.fragment.update': {
                const args = WidgetLayoutFragmentActionInputSchemasV1[actionId].parse(input);
                return accept({ fragment: await port.update(args.artifactId, args.patch, context.signal) });
            }
            case 'widgets.fragment.duplicate': {
                const args = WidgetLayoutFragmentActionInputSchemasV1[actionId].parse(input);
                return accept({ fragment: await port.duplicate(args.artifactId, args.newArtifactId, args.name, context.signal) });
            }
            case 'widgets.fragment.delete': {
                const args = WidgetLayoutFragmentActionInputSchemasV1[actionId].parse(input);
                await port.delete(args.artifactId, context.signal);
                return accept({ artifactId: args.artifactId, status: 'deleted' });
            }
        }
    } catch (error) {
        if (context.signal?.aborted) return failure('cancelled');
        return failure(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_fragment_failed');
    }
}
