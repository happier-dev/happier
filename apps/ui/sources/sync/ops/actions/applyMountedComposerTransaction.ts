import {
    ComposerTransactionResultV1Schema,
    type ComposerSnapshotV1,
    type ComposerTransactionV1,
} from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { readMountedComposerPresentationSnapshot, requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';

/**
 * Applies one user-initiated edit to the presented, editable composer at its observed revision,
 * then focuses it. Never sends. Unavailable, refused or stale leaves the draft untouched and
 * returns `false` so the caller can keep what the person typed and say so.
 */
export async function applyMountedComposerTransaction(input: Readonly<{
    scope: ServerAccountScope;
    ref: ComposerRefV1;
    attachmentContributor?: PluginContributionIdentityV1;
    operations: (snapshot: ComposerSnapshotV1) => ComposerTransactionV1['operations'];
}>): Promise<boolean> {
    const { scope, ref } = input;
    const snapshot = readMountedComposerPresentationSnapshot({ scope, ref });
    if (!snapshot?.state.editable) return false;
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const outcome = await createDefaultActionExecutor().execute('composer.transaction.apply', {
            scope, ref,
            ...(input.attachmentContributor ? { attachmentContributor: input.attachmentContributor } : {}),
            transaction: { expectedRevision: snapshot.revision, operations: input.operations(snapshot) },
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
        return false;
    }
}
