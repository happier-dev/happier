import type { AutomationDefinitionDetail, AutomationDefinitionListItem } from '@happier-dev/protocol';

import type { AutomationDefinition } from './automationTypes';

function hasConsistentExecutionRecipe(detail: AutomationDefinitionDetail): boolean {
    return !detail.executionRecipe || detail.executionRecipe.templateVersion === detail.templateVersion;
}

export function readAutomationDefinitionExistingSessionId(detail: AutomationDefinitionDetail): string | null {
    return hasConsistentExecutionRecipe(detail) ? detail.existingSessionId : null;
}

function triggerRevisionKey(trigger: AutomationDefinitionListItem['triggers'][number]): string {
    return `${trigger.id}:${trigger.revision}`;
}

/** Trigger revisions are independent of the recipe revision. */
export function hasMatchingAutomationDefinitionSummary(
    left: Pick<AutomationDefinitionListItem, 'targetType' | 'triggers'>,
    right: Pick<AutomationDefinitionListItem, 'targetType' | 'triggers'>,
): boolean {
    if (left.targetType !== right.targetType || left.triggers.length !== right.triggers.length) return false;
    const rightKeys = new Set(right.triggers.map(triggerRevisionKey));
    return left.triggers.every((trigger) => rightKeys.has(triggerRevisionKey(trigger)));
}

function summaryFromDetail(detail: AutomationDefinitionDetail): AutomationDefinitionListItem {
    const { executionRecipe: _executionRecipe, templateCiphertext: _templateCiphertext, ...summary } = detail;
    return summary;
}

function summaryFromDefinition(definition: AutomationDefinition): AutomationDefinitionListItem {
    const { detail: _detail, linkedExistingSessionId: _linkedExistingSessionId, ...summary } = definition;
    return summary;
}

function hasMatchingPrivateTriggerBinding(
    summaryTrigger: AutomationDefinitionListItem['triggers'][number],
    detailTrigger: AutomationDefinitionDetail['triggers'][number],
): boolean {
    if (
        summaryTrigger.id !== detailTrigger.id
        || summaryTrigger.revision !== detailTrigger.revision
        || summaryTrigger.kind !== detailTrigger.kind
    ) return false;
    if (summaryTrigger.kind !== 'pluginEvent' || detailTrigger.kind !== 'pluginEvent') return true;
    return summaryTrigger.eventRef.pluginId === detailTrigger.eventRef.pluginId
        && summaryTrigger.eventRef.localId === detailTrigger.eventRef.localId
        && summaryTrigger.sourceSelectorId === detailTrigger.sourceSelectorId
        && summaryTrigger.sourceContractVersion === detailTrigger.sourceContractVersion;
}

export function hasMatchingAutomationDefinitionTriggerBindings(
    left: Pick<AutomationDefinitionListItem, 'targetType' | 'triggers'>,
    right: Pick<AutomationDefinitionListItem, 'targetType' | 'triggers'>,
): boolean {
    if (!hasMatchingAutomationDefinitionSummary(left, right)) return false;
    const rightTriggersById = new Map(right.triggers.map((trigger) => [trigger.id, trigger]));
    return left.triggers.every((trigger) => {
        const matching = rightTriggersById.get(trigger.id);
        return matching ? hasMatchingPrivateTriggerBinding(trigger, matching) : false;
    });
}

export function createAutomationDefinitionSummary(summary: AutomationDefinitionListItem): AutomationDefinition {
    return {
        ...summary,
        detail: { kind: 'unloaded', templateVersion: summary.templateVersion },
        linkedExistingSessionId: summary.existingSessionId,
    };
}

export function createAutomationDefinitionFromDetail(detail: AutomationDefinitionDetail): AutomationDefinition {
    return {
        ...summaryFromDetail(detail),
        detail: { kind: 'available', templateVersion: detail.templateVersion, value: detail },
        linkedExistingSessionId: readAutomationDefinitionExistingSessionId(detail),
    };
}

export function markAutomationDefinitionContentUnavailable(summary: AutomationDefinition): AutomationDefinition {
    return {
        ...summary,
        detail: {
            kind: 'unavailable',
            templateVersion: summary.templateVersion,
            code: 'automation_stored_content_unavailable',
        },
        linkedExistingSessionId: summary.existingSessionId,
    };
}

export function attachAutomationDefinitionDetail(
    summary: AutomationDefinition,
    detail: AutomationDefinitionDetail,
): AutomationDefinition | null {
    if (
        detail.id !== summary.id
        || detail.templateVersion !== summary.templateVersion
        || !hasConsistentExecutionRecipe(detail)
        || !hasMatchingAutomationDefinitionSummary(summary, detail)
    ) return null;
    const detailTriggersById = new Map(detail.triggers.map((trigger) => [trigger.id, trigger]));
    const triggers: AutomationDefinitionDetail['triggers'] = [];
    for (const summaryTrigger of summary.triggers) {
        const detailTrigger = detailTriggersById.get(summaryTrigger.id);
        if (!detailTrigger || !hasMatchingPrivateTriggerBinding(summaryTrigger, detailTrigger)) return null;
        triggers.push(detailTrigger.kind === 'pluginEvent' && summaryTrigger.kind === 'pluginEvent'
            ? { ...detailTrigger, ...summaryTrigger, triggerDefinitionEnvelope: detailTrigger.triggerDefinitionEnvelope }
            : { ...detailTrigger, ...summaryTrigger });
    }
    return createAutomationDefinitionFromDetail({
        ...detail,
        ...summaryFromDefinition(summary),
        triggers,
    });
}

/** Trigger-only mutations may return the same recipe revision. */
export function applyAutomationDefinitionDetail(
    current: AutomationDefinition | null | undefined,
    detail: AutomationDefinitionDetail,
    options: Readonly<{ replaceEqualRevision?: boolean }> = {},
): AutomationDefinition {
    if (!current) return createAutomationDefinitionFromDetail(detail);
    if (current.id !== detail.id || current.templateVersion > detail.templateVersion) return current;
    if (current.templateVersion < detail.templateVersion || options.replaceEqualRevision === true) {
        return createAutomationDefinitionFromDetail(detail);
    }
    if (current.detail.kind === 'unavailable' || current.detail.kind === 'available') return current;
    return attachAutomationDefinitionDetail(current, detail) ?? current;
}
