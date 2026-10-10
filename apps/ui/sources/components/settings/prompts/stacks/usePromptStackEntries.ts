import * as React from 'react';
import type { PromptStackEntryV1 } from '@happier-dev/protocol';
import type { PromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PromptLibraryStackUpdateResultV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PromptLibraryRowOperationError } from '@/sync/api/account/apiPromptLibraryCatalog';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useProfilePromptStack } from '@/sync/store/useProfilePromptStack';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const EMPTY_ENTRIES: PromptStackEntryV1[] = [];

/** The editor and picker use the same Account-row or Profile-owned stack mutation. */
export function usePromptStackEntries(surface: 'coding' | 'voice' | 'profile', profileId?: string | null) {
    const scope = useAccountSettingsScope();
    const account = usePromptLibraryCatalogValue(surface === 'voice' ? 'voice' : 'coding', surface === 'profile' ? null : scope);
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const profile = useProfilePromptStack(surface === 'profile' ? profileId : null);
    const entries = surface === 'profile' ? profile.entries : account.value?.entries ?? EMPTY_ENTRIES;
    const update = React.useCallback(async (intent: PromptStackIntentV1): Promise<void> => {
        if (surface === 'profile') {
            await profile.update(intent);
            return;
        }
        if (!scope || account.status !== 'ready' || account.stale) throw new PromptLibraryRowOperationError('stack-unavailable');
        const result = await executor.execute('prompts.stack.update', { surface, expectedRevision: account.revision, intent }, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        });
        if (!result.ok) throw new PromptLibraryRowOperationError(result.errorCode, result);
        const mutation = PromptLibraryStackUpdateResultV1Schema.parse(result.result);
        if (mutation.status !== 'updated') throw new PromptLibraryRowOperationError(mutation.status, mutation);
    }, [surface, profile.update, account.status, account.stale, account.revision, executor, scope?.serverId, scope?.accountId]);
    return { entries, update };
}
