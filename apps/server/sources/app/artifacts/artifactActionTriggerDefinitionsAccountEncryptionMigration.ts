import { isDeepStrictEqual } from 'node:util';
import { ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema,
    type ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1 } from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import { AutomationActionTriggerSchema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { openAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactRevisionV1';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { automationActionTriggerConfigurationSelect, decodeAutomationActionTriggerConfiguration,
    type AutomationActionTriggerColumns } from '@/app/automations/automationActionTriggerConfiguration';
import { assertAutomationActionDefinitionStructuralMatch, readAutomationActionDefinitionEnvelope } from '@/app/automations/automationActionTriggerWrite';

type Definitions = ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1;
export type ArtifactActionTriggerDefinitionMigrationRow = AutomationActionTriggerColumns & Readonly<{
    id: string; automationId: string; revision: number; definitionEnvelope: string | null;
}>;

/** Resource ownership includes all authors and retained definitions; Account carriers stay Account-owned. */
export async function readArtifactActionTriggerDefinitionsInTx(tx: Tx, artifactIds: readonly string[]) {
    const census = new Map<string, { definitions: Definitions; rows: ArtifactActionTriggerDefinitionMigrationRow[] }>();
    for (const page of portableQueryChunks({ values: artifactIds, bindingsPerValue: 1, fixedBindings: 0 })) {
        const automations = await tx.automation.findMany({ where: { workflowDefinitionId: { in: [...page] } },
            orderBy: { id: 'asc' }, select: { id: true, workflowDefinitionId: true,
                triggers: { where: { kind: 'action', consentForAutomationId: null }, orderBy: { id: 'asc' }, select: {
                    id: true, automationId: true, revision: true, definitionEnvelope: true, ...automationActionTriggerConfigurationSelect,
                } } } });
        for (const automation of automations) {
            for (const row of automation.triggers) {
                if (!row.definitionEnvelope) continue;
                const envelope = readAutomationActionDefinitionEnvelope(row.definitionEnvelope);
                if (envelope.t !== 'workflow') continue;
                const entry = census.get(automation.workflowDefinitionId!) ?? { definitions: [], rows: [] };
                entry.definitions.push({ automationId: automation.id, triggerId: AutomationTriggerIdSchema.parse(row.id),
                    triggerRevision: row.revision, content: envelope.content });
                entry.rows.push(row);
                census.set(automation.workflowDefinitionId!, entry);
            }
        }
    }
    for (const entry of census.values()) entry.definitions = ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema.parse(entry.definitions);
    return census;
}

export function artifactActionTriggerDefinitionsMatch(actual: Definitions | undefined, expected: Definitions | undefined): boolean {
    return isDeepStrictEqual(actual ?? [], expected ?? []);
}

/** Conversion retains row bindings and routing; encrypted resource bytes remain opaque. */
export function artifactActionTriggerDefinitionsReplacementValid(source: Definitions | undefined, target: Definitions | undefined,
    rows: readonly ArtifactActionTriggerDefinitionMigrationRow[] | undefined, mode: 'plain' | 'e2ee'): boolean {
    if (!source || !target) return source === target;
    if (!isDeepStrictEqual(source.map(({ content: _content, ...binding }) => binding),
        target.map(({ content: _content, ...binding }) => binding))) return false;
    try {
        for (const [index, item] of target.entries()) {
            if (item.content.t !== (mode === 'plain' ? 'plain' : 'encrypted')) return false;
            if (item.content.t === 'plain') {
                const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', envelope: item.content,
                    binding: { v: 1, automationId: item.automationId, triggerId: item.triggerId,
                        triggerRevision: item.triggerRevision, triggerKind: 'action' } });
                if (opened.kind !== 'available' || !rows?.[index]) return false;
                const structural = decodeAutomationActionTriggerConfiguration(rows[index]!);
                if ('consentFor' in structural) return false;
                assertAutomationActionDefinitionStructuralMatch(AutomationActionTriggerSchema.parse(opened.definition), structural);
            }
        }
    } catch { return false; }
    return true;
}

/** The enclosing Artifact migration transaction commits the key and each exact retained carrier together. */
export async function writeArtifactActionTriggerDefinitionsInTx(tx: Tx, artifactId: string,
    rows: readonly ArtifactActionTriggerDefinitionMigrationRow[], target: Definitions, revision: ArtifactRevisionV1): Promise<boolean> {
    for (const [index, row] of rows.entries()) {
        const updated = await tx.automationTrigger.updateMany({ where: { id: row.id, automationId: row.automationId,
            revision: row.revision, definitionEnvelope: row.definitionEnvelope, automation: { workflowDefinitionId: artifactId } },
            data: { definitionEnvelope: JSON.stringify({ t: 'workflow', revision, content: target[index]!.content }) } });
        if (updated.count !== 1) return false;
    }
    return true;
}
