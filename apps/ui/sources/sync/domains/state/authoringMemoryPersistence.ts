import {
    LastUsedProfileSchema,
    RecentMachinePathSchema,
    RememberedEngineSelectionsByScopeV1Schema as RetainedRememberedEngineSelectionsByScopeV1Schema,
} from '@happier-dev/protocol/account/authoringMemory';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { z } from 'zod/mini';

import {
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

import { getPersistenceStorage } from './persistenceStorage';
import { WorkflowProjectTargetsByDefinitionIdV1Schema } from '@happier-dev/protocol/account/authoringMemory';

const AuthoringMemoryProjectionSchema: z.ZodMiniObject<{
    recentMachinePaths: z.ZodMiniArray<typeof RecentMachinePathSchema>;
    lastUsedProfile: typeof LastUsedProfileSchema;
    lastEngineSelectionsByScopeV1: typeof RetainedRememberedEngineSelectionsByScopeV1Schema;
    workflowProjectTargetsByDefinitionId: z.ZodMiniOptional<typeof WorkflowProjectTargetsByDefinitionIdV1Schema>;
}, z.core.$strict> = z.strictObject({
    // A persisted projection is admitted as a whole.
    recentMachinePaths: z.array(RecentMachinePathSchema),
    lastUsedProfile: LastUsedProfileSchema,
    lastEngineSelectionsByScopeV1: RetainedRememberedEngineSelectionsByScopeV1Schema,
    workflowProjectTargetsByDefinitionId: z.optional(WorkflowProjectTargetsByDefinitionIdV1Schema),
});
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
        ...(values.workflowProjectTargetsByDefinitionId === undefined ? {} : { workflowProjectTargetsByDefinitionId: values.workflowProjectTargetsByDefinitionId }),
    });
    getPersistenceStorage().set(projectionKey(scope), JSON.stringify(projection));
}
