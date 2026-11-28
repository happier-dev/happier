import type { ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';
import type { InputTypePickerHostContext } from './InputTypePickerHostProvider';
import { buildActionDraftInput } from '@/sync/domains/actions/buildActionDraftInput';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/** Catalog Actions share the ordinary draft, form and executor owners on every UI entry. */
export async function openCatalogAction(params: Readonly<{
    spec: ActionSpec;
    context: SessionBoundActionToolContext;
    pickerContext?: InputTypePickerHostContext;
    execute: (input: Readonly<Record<string, unknown>>) => Promise<ActionExecuteResult>;
}>): Promise<void> {
    const input = buildActionDraftInput({ actionId: params.spec.id, context: params.context });
    const parsed = params.spec.inputSchema.safeParse(input);
    if (parsed.success) {
        const result = await params.execute(parsed.data);
        const { presentActionExecutionResult } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
        presentActionExecutionResult(result);
        return;
    }
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [{ createActionInputForm }, { presentActionInputForm }] = await Promise.all([
        import('@/components/plugins/actions/actionInputForm'),
        import('@/components/plugins/actions/presentActionInputForm'),
    ]);
    const form = createActionInputForm({
        presentation: { title: params.spec.title, description: params.spec.description ?? null,
            inputHints: params.spec.inputHints ?? { fields: [] } },
        initialInput: input,
        accountLifetime,
        submit: async candidate => {
            const result = await params.execute(candidate);
            if (result.ok) {
                const { presentActionExecutionResult } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
                presentActionExecutionResult(result);
            }
            return result.ok ? { ok: true } : { ...result, code: result.errorCode, message: result.error };
        },
    });
    presentActionInputForm({ form, actionId: params.spec.id, pickerContext: params.pickerContext,
        validateInput: candidate => {
            const result = params.spec.inputSchema.safeParse(candidate);
            if (result.success) return undefined;
            const issue = result.error.issues[0];
            return { message: issue?.message, path: issue?.path.map(String).join('.') };
        },
    });
}
