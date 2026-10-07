import { ComposerTransactionResultV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';

import { readMountedComposerPresentationSnapshot, requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';

/** Append a request without sending or replacing the person's draft; focus only after it lands. */
export async function appendMountedComposerDraft(input: Readonly<{
    scope: ServerAccountScope;
    ref: ComposerRefV1;
    text: string;
}>): Promise<boolean> {
    const { scope, ref } = input;
    const snapshot = readMountedComposerPresentationSnapshot({ scope, ref });
    if (!snapshot?.state.editable) return false;
    const text = snapshot.text.length > 0 && !snapshot.text.endsWith('\n') ? `\n${input.text}` : input.text;
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const outcome = await createDefaultActionExecutor().execute('composer.transaction.apply', {
            scope, ref, transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'text.insert', position: { offset: snapshot.text.length }, text }],
            },
        }, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId,
            expectedAccountId: scope.accountId, actionRequestId: randomUUID(),
        });
        if (!outcome.ok) return false;
        const parsed = ComposerTransactionResultV1Schema.safeParse(outcome.result);
        if (!parsed.success || parsed.data.status !== 'applied') return false;
        requestRegisteredComposerFocus(ref);
        return true;
    } catch {
        // Match Change with the agent: unavailable, refused or stale leaves the draft untouched.
        return false;
    }
}
