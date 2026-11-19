import {
    ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema,
    type ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1,
} from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import {
    AutomationTriggerDefinitionBindingV1Schema,
    AutomationTriggerDefinitionStoredPayloadV1Schema,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';

import type { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

/** Resource-associated definitions move with the same source and replacement Artifact keys. */
export async function buildArtifactActionTriggerDefinitionsAccountEncryptionMigration(params: Readonly<{
    definitions: ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1;
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    sourceEncryption: ArtifactEncryption | null;
    targetEncryption: ArtifactEncryption | null;
}>): Promise<ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1> {
    const definitions = ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema.parse(params.definitions);
    const target: ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1 = [];
    for (const item of definitions) {
        const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1,
            automationId: item.automationId, triggerId: item.triggerId,
            triggerRevision: item.triggerRevision, triggerKind: 'action' });
        if (item.content.t !== (params.fromMode === 'plain' ? 'plain' : 'encrypted')) {
            throw new Error('artifact_action_trigger_definition_migration_mode_mismatch');
        }
        const raw = item.content.t === 'plain'
            ? item.content.v
            : await params.sourceEncryption?.decryptHeaderRaw(item.content.c);
        if (!raw) throw new Error('artifact_action_trigger_definition_migration_source_locked');
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            envelope: { t: 'plain', v: raw } });
        if (opened.kind !== 'available') {
            throw new Error('artifact_action_trigger_definition_migration_binding_mismatch');
        }
        const payload = AutomationTriggerDefinitionStoredPayloadV1Schema.parse({ v: 1, binding,
            definition: opened.definition });
        const content = params.toMode === 'plain'
            ? { t: 'plain' as const, v: payload }
            : params.targetEncryption
                ? { t: 'encrypted' as const, c: await params.targetEncryption.encryptHeader(payload) }
                : null;
        if (!content) throw new Error('artifact_action_trigger_definition_migration_target_material_unavailable');
        target.push({ automationId: item.automationId, triggerId: item.triggerId,
            triggerRevision: item.triggerRevision, content });
    }
    return ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema.parse(target);
}
