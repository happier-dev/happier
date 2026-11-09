import * as React from 'react';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { PromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PromptLibraryStackUpdateResultV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PromptLibraryRowOperationError } from '@/sync/api/account/apiPromptLibraryCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useProfilePromptStack } from '@/sync/store/useProfilePromptStack';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const EMPTY_ENTRIES: PromptStackEntryV1[] = [];

/** The editor and picker use the same Account-row or Profile-owned stack mutation. */
export function usePromptStackEntries(surface: 'coding' | 'voice' | 'profile', profileId?: string | null) {
    const scope = useAccountSettingsScope();
    const account = usePromptLibraryCatalogValue(surface === 'voice' ? 'voice' : 'coding', surface === 'profile' ? null : scope);
    const { execute } = useMountedActionExecution(scope);
    const profile = useProfilePromptStack(surface === 'profile' ? profileId : null);
    const entries = surface === 'profile' ? profile.entries : account.value?.entries ?? EMPTY_ENTRIES;
    const canUpdate = surface === 'profile' ? profile.canUpdate : Boolean(scope && account.status === 'ready' && !account.stale);
    const update = React.useCallback(async (intent: PromptStackIntentV1): Promise<void> => {
        if (surface === 'profile') {
            await profile.update(intent);
            return;
        }
        if (!canUpdate) throw new PromptLibraryRowOperationError('stack-unavailable');
        const result = await execute('prompts.stack.update', { surface, expectedRevision: account.revision, intent });
        if (!result.ok) throw new PromptLibraryRowOperationError(result.errorCode, result);
        const mutation = PromptLibraryStackUpdateResultV1Schema.parse(result.result);
        if (mutation.status !== 'updated') throw new PromptLibraryRowOperationError(mutation.status, mutation);
    }, [surface, profile.update, canUpdate, account.revision, execute]);
    return {
        entries, update, canUpdate,
        hasLoadedEntries: surface === 'profile' ? profile.available : account.value !== null,
        status: surface === 'profile' ? profile.status : account.status,
        stale: surface === 'profile' ? profile.stale : account.stale,
    };
}
