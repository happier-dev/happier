import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    createAutomationDefinition,
    isAutomationApiErrorCode,
    reconcileAutomationDefinition,
} from '@/sync/api/automations/apiAutomations';
import {
    AutomationTriggerDefinitionSchema,
    AutomationTriggerIdSchema,
    AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
    type AutomationDefinitionDetail,
    type AutomationEventTriggerDefinitionStoredPayloadV1,
    type AutomationPluginEventDefinitionTriggerInput,
    type AutomationEncryptedTriggerDefinitionEnvelopeV1,
    type AutomationTriggerDefinitionBindingV1,
    type AutomationTriggerDefinitionInput,
} from '@happier-dev/protocol';

import type { AutomationEditorDraft } from './automationEditorDraft';
import { getAutomationEditorTriggerEnabled, getAutomationEditorTriggerKind } from './automationEditorDraft';

export class AutomationEditorSaveStaleError extends Error {
    readonly code = 'automation_editor_save_stale';

    constructor() {
        super('Automation editor authority changed while saving');
    }
}

function assertCurrent(isCurrent: () => boolean): void {
    if (!isCurrent()) throw new AutomationEditorSaveStaleError();
}

type SealAutomationTriggerDefinition = (params: Readonly<{
    binding: AutomationTriggerDefinitionBindingV1;
    definition: AutomationEventTriggerDefinitionStoredPayloadV1;
}>) => AutomationEncryptedTriggerDefinitionEnvelopeV1;

function prepareTriggerForWrite(params: Readonly<{
    automationId: string;
    triggerId: ReturnType<typeof AutomationTriggerIdSchema.parse>;
    triggerRevision: number;
    trigger: AutomationEditorDraft['triggers'][number];
    sealAutomationTriggerDefinition?: SealAutomationTriggerDefinition;
}>): AutomationTriggerDefinitionInput {
    const definition = params.trigger.definition;
    if (!definition) throw new AutomationEditorSaveStaleError();
    if (
        definition.kind !== 'pluginEvent'
        || !('sourceInstanceId' in definition)
        || !params.sealAutomationTriggerDefinition
    ) return definition;
    const sourceBinding = params.trigger.eventSourceBinding;
    if (!sourceBinding || sourceBinding.sourceInstanceId !== definition.sourceInstanceId) {
        throw new AutomationEditorSaveStaleError();
    }
    const storedDefinition: AutomationEventTriggerDefinitionStoredPayloadV1 = {
        v: 1,
        sourceInstanceId: definition.sourceInstanceId,
        ...(definition.observationTransport.kind === 'durablePush' ? {
            webhookRoutingSourceInstanceId: definition.observationTransport.webhookRoutingSourceInstanceId,
        } : {}),
        sourceConfig: definition.sourceConfig,
        displayLabel: definition.displayLabel,
        filter: definition.filter,
        maximumObservationAgeMs: definition.maximumObservationAgeMs,
    };
    const triggerDefinitionEnvelope = params.sealAutomationTriggerDefinition({
        binding: {
            v: 1,
            automationId: params.automationId,
            triggerId: params.triggerId,
            triggerRevision: params.triggerRevision,
            triggerKind: 'pluginEvent',
            eventRef: definition.eventRef,
            sourceSelectorId: sourceBinding.sourceSelectorId,
        },
        definition: storedDefinition,
    });
    const encrypted: AutomationPluginEventDefinitionTriggerInput = {
        kind: 'pluginEvent',
        enabled: definition.enabled,
        eventRef: definition.eventRef,
        sourceSelectorId: sourceBinding.sourceSelectorId,
        sourceContractVersion: definition.sourceContractVersion,
        observationTransport: definition.observationTransport,
        triggerDefinitionEnvelope,
    };
    return encrypted;
}

/**
 * The sole UI authoring writer. It owns definition mutation plus exact trigger
 * reconciliation; screens and Session actions provide drafts, never issue
 * schedule/Event/lifecycle mutations directly.
 */
export async function saveAutomationEditorDraft(params: Readonly<{
    credentials: AuthCredentials;
    draft: AutomationEditorDraft;
    isCurrent?: () => boolean;
    sealAutomationTriggerDefinition?: SealAutomationTriggerDefinition;
}>): Promise<AutomationDefinitionDetail> {
    const isCurrent = params.isCurrent ?? (() => true);
    assertCurrent(isCurrent);
    const encryptionMode = await fetchAccountEncryptionMode(params.credentials, { retry: 'none' });
    assertCurrent(isCurrent);
    const sealAutomationTriggerDefinition = encryptionMode.mode === 'e2ee'
        ? params.sealAutomationTriggerDefinition
        : undefined;
    const needsEncryptedEventReseal = params.draft.triggers.some((trigger) => (
        getAutomationEditorTriggerKind(trigger) === 'pluginEvent'
        && (trigger.persisted === null || trigger.isDirty === true)
    ));
    if (encryptionMode.mode === 'e2ee' && needsEncryptedEventReseal && !sealAutomationTriggerDefinition) {
        throw new AutomationEditorSaveStaleError();
    }

    if (params.draft.automationId === null) {
        if (params.draft.expectedTemplateVersion !== null) throw new AutomationEditorSaveStaleError();
        const automationId = params.draft.pendingAutomationId;
        if (!automationId) throw new AutomationEditorSaveStaleError();
        if (params.draft.triggers.some((trigger) => trigger.definition === null)) {
            throw new AutomationEditorSaveStaleError();
        }
        const created = await createAutomationDefinition(params.credentials, {
            automationId,
            name: params.draft.name,
            description: params.draft.description,
            enabled: params.draft.enabled,
            executionRecipe: params.draft.executionRecipe,
            assignments: [...params.draft.assignments],
            triggers: params.draft.triggers.map((trigger) => {
                const triggerId = AutomationTriggerIdSchema.parse(trigger.clientId);
                return {
                    triggerId,
                    trigger: prepareTriggerForWrite({
                        automationId,
                        triggerId,
                        triggerRevision: 0,
                        trigger,
                        sealAutomationTriggerDefinition,
                    }),
                };
            }),
        });
        assertCurrent(isCurrent);
        return created;
    }

    if (params.draft.expectedTemplateVersion === null) throw new AutomationEditorSaveStaleError();
    if (params.draft.pendingAutomationId !== null) throw new AutomationEditorSaveStaleError();
    if (
        params.draft.recipeDirty === true
        && params.draft.executionRecipe.templateVersion !== params.draft.expectedTemplateVersion + 1
    ) throw new AutomationEditorSaveStaleError();
    const automationId = params.draft.automationId;
    const retainedById = new Map(
        params.draft.triggers.flatMap((trigger) => trigger.persisted ? [[trigger.persisted.id, trigger]] : []),
    );
    const removedById = new Map(params.draft.removedTriggers.map((trigger) => [trigger.id, trigger]));
    if (
        params.draft.triggers.filter((trigger) => trigger.persisted !== null).length !== retainedById.size
        || params.draft.removedTriggers.length !== removedById.size
    ) {
        throw new AutomationEditorSaveStaleError();
    }

    const triggers = params.draft.triggers.map((trigger) => {
        if (trigger.persisted === null) {
            if (!trigger.definition) throw new AutomationEditorSaveStaleError();
            const triggerId = AutomationTriggerIdSchema.parse(trigger.clientId);
            return {
                kind: 'new' as const,
                triggerId,
                trigger: prepareTriggerForWrite({
                    automationId,
                    triggerId,
                    triggerRevision: 0,
                    trigger,
                    sealAutomationTriggerDefinition,
                }),
            };
        }
        if (trigger.isDirty !== true) {
            return {
                kind: 'existing' as const,
                triggerId: trigger.persisted.id,
                expectedRevision: trigger.persisted.revision,
            };
        }
        const prepared = trigger.definition ? prepareTriggerForWrite({
                automationId,
                triggerId: trigger.persisted.id,
                triggerRevision: trigger.persisted.revision + 1,
                trigger,
                sealAutomationTriggerDefinition,
            }) : null;
        const patchDefinition = prepared
            ? AutomationTriggerDefinitionSchema.parse((({ enabled: _enabled, ...value }) => value)(prepared))
            : null;
        const resealedEnableOnlyEnvelope = !prepared && sealAutomationTriggerDefinition
            ? (() => {
                const sourceBinding = trigger.eventSourceBinding;
                const privateDefinition = trigger.retainedEventPrivateDefinition;
                const retainedEvent = trigger.retainedEvent;
                if (!sourceBinding || !privateDefinition || !retainedEvent) {
                    throw new AutomationEditorSaveStaleError();
                }
                return AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
                    sealAutomationTriggerDefinition({
                        binding: {
                            v: 1,
                            automationId,
                            triggerId: trigger.persisted.id,
                            triggerRevision: trigger.persisted.revision + 1,
                            triggerKind: 'pluginEvent',
                            eventRef: retainedEvent.eventRef,
                            sourceSelectorId: sourceBinding.sourceSelectorId,
                        },
                        definition: privateDefinition,
                    }),
                );
            })()
            : null;
        return {
            kind: 'existing' as const,
            triggerId: trigger.persisted.id,
            expectedRevision: trigger.persisted.revision,
            enabled: getAutomationEditorTriggerEnabled(trigger),
            ...(patchDefinition ? { trigger: patchDefinition } : {}),
            ...(resealedEnableOnlyEnvelope ? {
                triggerDefinitionEnvelope: resealedEnableOnlyEnvelope,
            } : {}),
        };
    });

    let current: AutomationDefinitionDetail;
    try {
        current = await reconcileAutomationDefinition(params.credentials, automationId, {
            expectedTemplateVersion: params.draft.expectedTemplateVersion,
            name: params.draft.name,
            description: params.draft.description,
            enabled: params.draft.enabled,
            ...(params.draft.recipeDirty === true ? { executionRecipe: params.draft.executionRecipe } : {}),
            assignments: [...params.draft.assignments],
            triggers,
            removedTriggers: params.draft.removedTriggers.map((trigger) => ({
                triggerId: trigger.id,
                expectedRevision: trigger.revision,
            })),
        });
    } catch (error) {
        if (
            isAutomationApiErrorCode(error, 'automation_template_version_conflict')
            || isAutomationApiErrorCode(error, 'automation_trigger_revision_conflict')
        ) throw new AutomationEditorSaveStaleError();
        throw error;
    }
    assertCurrent(isCurrent);
    return current;
}
