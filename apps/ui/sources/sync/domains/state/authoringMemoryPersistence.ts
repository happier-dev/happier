import {
    LegacyLastUsedProfileSchema,
    LegacyRecentMachinePathSchema,
    LegacyRememberedEngineSelectionsByScopeV1Schema,
} from '@happier-dev/protocol';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { z } from 'zod';

import {
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

import { getPersistenceStorage } from './persistenceStorage';

const AuthoringMemoryProjectionSchema: z.ZodObject<{
    recentMachinePaths: z.ZodArray<typeof LegacyRecentMachinePathSchema>;
    lastUsedProfile: typeof LegacyLastUsedProfileSchema;
    lastEngineSelectionsByScopeV1: typeof LegacyRememberedEngineSelectionsByScopeV1Schema;
}, z.core.$strict> = z.object({
    // A persisted projection is admitted as a whole, unlike legacy import's
    // malformed-sibling recovery.
    recentMachinePaths: z.array(LegacyRecentMachinePathSchema),
    lastUsedProfile: LegacyLastUsedProfileSchema,
    lastEngineSelectionsByScopeV1: LegacyRememberedEngineSelectionsByScopeV1Schema,
}).strict();
const StoredAuthoringMemoryProjectionSchema = createStoredReadSchema(AuthoringMemoryProjectionSchema);

type AuthoringMemoryProjection = Readonly<z.output<typeof AuthoringMemoryProjectionSchema>>;

function projectionKey(scope: AccountSettingsScope): string {
    return `authoring-memory:v1:${accountSettingsScopeKeySuffix(scope)}`;
}

/** A device-local read projection; canonical rows remain the sync authority. */
export function loadAuthoringMemoryProjection(scope: AccountSettingsScope): AuthoringMemoryProjection | null {
    const raw = getPersistenceStorage().getString(projectionKey(scope));
    if (typeof raw !== 'string') return null;
    try {
        const parsed = StoredAuthoringMemoryProjectionSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function saveAuthoringMemoryProjection(scope: AccountSettingsScope, values: AuthoringMemoryProjection): void {
    const projection = AuthoringMemoryProjectionSchema.parse({
        recentMachinePaths: values.recentMachinePaths,
        lastUsedProfile: values.lastUsedProfile,
        lastEngineSelectionsByScopeV1: values.lastEngineSelectionsByScopeV1,
    });
    getPersistenceStorage().set(projectionKey(scope), JSON.stringify(projection));
}
