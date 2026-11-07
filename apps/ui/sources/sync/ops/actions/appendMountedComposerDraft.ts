import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { applyMountedComposerTransaction } from './applyMountedComposerTransaction';

/** Append a request without sending or replacing the person's draft; focus only after it lands. */
export async function appendMountedComposerDraft(input: Readonly<{
    scope: ServerAccountScope;
    ref: ComposerRefV1;
    text: string;
    callerContext?: ActionExecutorContext;
}>): Promise<boolean> {
    return await applyMountedComposerTransaction({
        scope: input.scope,
        ref: input.ref,
        callerContext: input.callerContext,
        operations: (snapshot) => [{
            kind: 'text.insert',
            position: { offset: snapshot.text.length },
            text: snapshot.text.length > 0 && !snapshot.text.endsWith('\n') ? `\n${input.text}` : input.text,
        }],
    });
}
