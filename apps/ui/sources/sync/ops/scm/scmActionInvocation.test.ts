import { describe, expect, expectTypeOf, it } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol/scm';
import { invokeUiScmAction, type UiScmActionExecutor, type UiScmActionFailure } from './scmActionInvocation';

const settled = (result: unknown): UiScmActionExecutor => ({
    execute: async () => ({ ok: true, result }),
});

// The Protocol owns Zod Mini response schemas; the UI Action invoker must accept them as-is.
describe('invokeUiScmAction with a Protocol (Zod Mini) response schema', () => {
    it('settles an aborted read as cancelled without invoking the machine', async () => {
        const abort = new AbortController();
        abort.abort();
        const result = await invokeUiScmAction({ actionId: 'scm.diff.file', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: { signal: abort.signal },
            executor: settled({}) });
        expect(result).toMatchObject({ success: false, errorCode: 'COMMAND_CANCELLED' });
    });
    it('parses a valid response and keeps the schema output type', async () => {
        const failure = { success: false, error: 'No model selected.', errorCode: 'MODEL_UNAVAILABLE' };
        const result = await invokeUiScmAction({ actionId: 'scm.diffSummary.generate', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor: settled(failure) });
        expectTypeOf(result).toEqualTypeOf<ScmDiffSummaryGenerateOutput | UiScmActionFailure>();
        expect(result).toEqual(failure);
    });

    it('reports an invalid_action_output failure for a response the schema rejects', async () => {
        const result = await invokeUiScmAction({ actionId: 'scm.diffSummary.generate', input: {},
            schema: ScmDiffSummaryGenerateOutputSchema, context: {}, executor: settled({ success: 'maybe' }) });
        expect(result).toMatchObject({ success: false, errorCode: 'invalid_action_output' });
    });
});
