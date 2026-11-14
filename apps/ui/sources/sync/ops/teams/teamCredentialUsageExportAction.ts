import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import {
    buildTeamCredentialUsageExportFromRecipientProjectionV1,
    TeamCredentialUsageQueryResultV1Schema,
} from '@happier-dev/protocol/teams';

import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createPrivateLabelClientForActionAccountContext } from '@/sync/ops/privateLabels/privateLabelClient';

type HomeDomainAction = NonNullable<ActionExecutorDeps['homeDomainAction']>;
type TeamCredentialUsageExportAction = NonNullable<ActionExecutorDeps['teamCredentialUsageExport']>;

const TEAM_RESOURCE_LABEL_READ_POLICY = { kind: 'team-resource' } as const;

/**
 * The existing export Action is admitted before this client port runs. It reads
 * the Home's authorized opaque usage projection, opens only recipient labels
 * with the captured Account key, then serializes the local file.
 */
export function createUiTeamCredentialUsageExportAction(
    account: LazyActionAccountContext,
    homeDomainAction: HomeDomainAction,
): TeamCredentialUsageExportAction {
    return async ({ input, context, signal }) => {
        const actionSignal = signal ?? context.signal;
        const labels = createPrivateLabelClientForActionAccountContext(account);
        const exported = await buildTeamCredentialUsageExportFromRecipientProjectionV1({
            input,
            ...(actionSignal ? { signal: actionSignal } : {}),
            readPage: async query => {
                actionSignal?.throwIfAborted();
                account.assertCurrent();
                const raw = await homeDomainAction({
                    actionId: 'teams.credentials.usage.query',
                    input: query,
                    context,
                    ...(actionSignal ? { signal: actionSignal } : {}),
                });
                actionSignal?.throwIfAborted();
                account.assertCurrent();
                const failure = readActionFailureEnvelope(raw);
                if (failure) return failure;
                const page = TeamCredentialUsageQueryResultV1Schema.safeParse(raw);
                return page.success
                    ? page.data
                    : { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            },
            openLabel: async ({ binding, label, signal: labelSignal }) => await labels.open({
                binding,
                label,
                readPolicy: TEAM_RESOURCE_LABEL_READ_POLICY,
                ...(labelSignal ? { signal: labelSignal } : {}),
            }),
        });

        actionSignal?.throwIfAborted();
        account.assertCurrent();
        return exported;
    };
}
