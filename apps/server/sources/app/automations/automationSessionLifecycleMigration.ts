import type { AutomationDefinitionPatchRequest } from '@happier-dev/protocol/automations/automationApiV3';
import { projectAutomationSessionLifecycleStructuralTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { openAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import type { AutomationListItem } from './automationTypes';
import { reconstructAutomationSessionLifecycleLegacySelection } from './automationSessionLifecycleConfigurationCodec';
import { AutomationValidationError } from './automationValidation';
import { AutomationStoredContentReadError, validateAutomationTriggerDefinitionEnvelopeOuterForMode } from './automationStoredContentRead';

export const legacyAutomationSessionSelectionWhere = {
    kind: 'sessionLifecycle', deletedAt: null, definitionEnvelope: null,
} as const satisfies Prisma.AutomationTriggerWhereInput;

export const legacyAutomationSessionSelectionSelect = {
    id: true, revision: true, sessionLifecycleEventsJson: true, sessionLifecyclePolicyKind: true,
    sessionLifecycleMatchCount: true, remainingOccurrences: true, sourceSessionId: true, sourceTurnId: true,
} as const satisfies Prisma.AutomationTriggerSelect;

/** Reconstruct only the old stored selection, never an ordinary reader fallback. */
export function readLegacyAutomationSessionSelection(
    trigger: Parameters<typeof reconstructAutomationSessionLifecycleLegacySelection>[0], serverId: string,
) {
    try {
        return reconstructAutomationSessionLifecycleLegacySelection(trigger, serverId);
    } catch {
        throw new AutomationStoredContentReadError('contentInvalid');
    }
}

/** One-time retained 0.3 format rewrite; registration and runtime state stay intact. */
export async function migrateLegacyAutomationSessionSelectionsTx(tx: Tx, params: Readonly<{
    automation: AutomationListItem;
    migrations: NonNullable<AutomationDefinitionPatchRequest['sessionLifecycleMigrations']>;
    serverId: string;
    mode: 'plain' | 'e2ee';
}>): Promise<AutomationListItem> {
    const legacy = params.automation.triggers.filter(trigger => trigger.kind === 'sessionLifecycle'
        && trigger.definitionEnvelope === null && trigger.deletedAt === null);
    const submitted = new Map(params.migrations.map(item => [item.triggerId, item]));
    if (legacy.length === 0 || submitted.size !== params.migrations.length || submitted.size !== legacy.length) {
        throw new AutomationValidationError('Session selection repair requires the complete retained registration set');
    }
    const migrated = new Map<string, { definitionEnvelope: string; subjectKind: string | null; subjectKey: string | null; sourceSessionId: string | null }>();
    for (const trigger of legacy) {
        const migration = submitted.get(trigger.id);
        if (!migration || migration.expectedRevision !== trigger.revision) {
            throw new AutomationValidationError('Session selection repair revision no longer matches');
        }
        const definition = { kind: 'sessionLifecycle' as const,
            ...readLegacyAutomationSessionSelection(trigger, params.serverId) };
        const structural = projectAutomationSessionLifecycleStructuralTrigger(definition);
        const binding = { v: 1 as const, automationId: params.automation.id, triggerId: trigger.id,
            triggerRevision: trigger.revision, triggerKind: 'sessionLifecycle' as const };
        const raw = JSON.stringify(migration.triggerDefinitionEnvelope);
        const outer = validateAutomationTriggerDefinitionEnvelopeOuterForMode({ raw, mode: params.mode, binding });
        if (outer.kind !== 'available') {
            throw new AutomationStoredContentReadError(outer.kind === 'modeMismatch' ? 'modeMismatch' : 'contentInvalid');
        }
        if (params.mode === 'plain') {
            const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                envelope: migration.triggerDefinitionEnvelope });
            if (opened.kind !== 'available' || !pluginJsonValuesEqual(opened.definition, definition)) {
                throw new AutomationValidationError('Session selection repair must preserve the retained selection');
            }
        }
        const projection = { definitionEnvelope: raw, subjectKind: structural.subjectKind ?? null,
            subjectKey: structural.subjectKey ?? null, sourceSessionId: structural.sourceSessionId ?? null };
        const updated = await tx.automationTrigger.updateMany({
            where: { id: trigger.id, automationId: params.automation.id, revision: migration.expectedRevision,
                kind: 'sessionLifecycle', deletedAt: null, definitionEnvelope: null,
                automation: { accountId: params.automation.accountId, templateVersion: params.automation.templateVersion } },
            data: { ...projection, updatedAt: trigger.updatedAt },
        });
        if (updated.count !== 1) throw new AutomationValidationError('Session selection repair revision no longer matches');
        migrated.set(trigger.id, projection);
    }
    return { ...params.automation, triggers: params.automation.triggers.map(trigger => ({ ...trigger, ...migrated.get(trigger.id) })) };
}
