import type {
    AutomationDefinitionDetail,
    AutomationDefinitionListItem,
} from '@happier-dev/protocol';

import type {
    AutomationDefinition,
    AutomationDefinitionAvailable,
    AutomationDefinitionDetailForTrigger,
    AutomationDefinitionListItemForTrigger,
} from './automationTypes';
import {
    arePluginContributionIdentitiesEqual,
    arePluginMachineMaterializationRefsEqual,
} from './pluginEventAutomationCurrentness';

type ScheduleSummary = AutomationDefinitionListItemForTrigger<'schedule'>;
type ManualSummary = AutomationDefinitionListItemForTrigger<'manual'>;
type PluginEventSummary = AutomationDefinitionListItemForTrigger<'pluginEvent'>;

type ScheduleDetail = AutomationDefinitionDetailForTrigger<'schedule'>;
type ManualDetail = AutomationDefinitionDetailForTrigger<'manual'>;
type PluginEventDetail = AutomationDefinitionDetailForTrigger<'pluginEvent'>;

type ScheduleDefinition = Extract<AutomationDefinition, Readonly<{
    trigger: Readonly<{ kind: 'schedule' }>;
}>>;
type ManualDefinition = Extract<AutomationDefinition, Readonly<{
    trigger: Readonly<{ kind: 'manual' }>;
}>>;
type PluginEventDefinition = Extract<AutomationDefinition, Readonly<{
    trigger: Readonly<{ kind: 'pluginEvent' }>;
}>>;

function isScheduleDetail(detail: AutomationDefinitionDetail): detail is ScheduleDetail {
    return detail.trigger.kind === 'schedule';
}

function isManualDetail(detail: AutomationDefinitionDetail): detail is ManualDetail {
    return detail.trigger.kind === 'manual';
}

function isPluginEventDetail(detail: AutomationDefinitionDetail): detail is PluginEventDetail {
    return detail.trigger.kind === 'pluginEvent';
}

function isScheduleDefinition(definition: AutomationDefinition): definition is ScheduleDefinition {
    return definition.trigger.kind === 'schedule';
}

function isManualDefinition(definition: AutomationDefinition): definition is ManualDefinition {
    return definition.trigger.kind === 'manual';
}

function isPluginEventDefinition(definition: AutomationDefinition): definition is PluginEventDefinition {
    return definition.trigger.kind === 'pluginEvent';
}

function summaryFromDetail(detail: ScheduleDetail): ScheduleSummary;
function summaryFromDetail(detail: ManualDetail): ManualSummary;
function summaryFromDetail(detail: PluginEventDetail): PluginEventSummary;
function summaryFromDetail(detail: AutomationDefinitionDetail): AutomationDefinitionListItem {
    const {
        triggerDefinitionEnvelope: _triggerDefinitionEnvelope,
        executionRecipe: _executionRecipe,
        templateCiphertext: _templateCiphertext,
        ...summary
    } = detail;
    return summary;
}

function currentSummaryFromDefinition(definition: ScheduleDefinition): ScheduleSummary;
function currentSummaryFromDefinition(definition: ManualDefinition): ManualSummary;
function currentSummaryFromDefinition(definition: PluginEventDefinition): PluginEventSummary;
function currentSummaryFromDefinition(definition: AutomationDefinition): AutomationDefinitionListItem;
function currentSummaryFromDefinition(definition: AutomationDefinition): AutomationDefinitionListItem {
    const {
        detail: _detail,
        linkedExistingSessionId: _linkedExistingSessionId,
        ...summary
    } = definition;
    return summary;
}

function hasConsistentAutomationDefinitionExecutionRecipe(
    detail: AutomationDefinitionDetail,
): boolean {
    const executionRecipe = detail.executionRecipe;
    return !executionRecipe || executionRecipe.templateVersion === detail.templateVersion;
}

/**
 * The definition owner projects the existing-Session association on every
 * response, so summaries and direct reads share one source instead of the
 * summary path re-deriving it. Current direct recipes are still correlated to
 * their enclosing definition revision before the association is used.
 */
export function readAutomationDefinitionExistingSessionId(
    detail: AutomationDefinitionDetail,
): string | null {
    if (!hasConsistentAutomationDefinitionExecutionRecipe(detail)) return null;
    return detail.existingSessionId;
}

function linkedExistingSessionId(detail: AutomationDefinitionDetail): string | null {
    return readAutomationDefinitionExistingSessionId(detail);
}

function sameScheduleTrigger(
    left: ScheduleSummary['trigger'],
    right: ScheduleSummary['trigger'] | ScheduleDetail['trigger'],
): boolean {
    return left.schedule.kind === right.schedule.kind
        && left.schedule.scheduleExpr === right.schedule.scheduleExpr
        && left.schedule.everyMs === right.schedule.everyMs
        && left.schedule.timezone === right.schedule.timezone;
}

function samePluginEventTrigger(
    left: PluginEventSummary['trigger'],
    right: PluginEventSummary['trigger'] | PluginEventDetail['trigger'],
): boolean {
    if (
        !arePluginContributionIdentitiesEqual(left.eventRef, right.eventRef)
        || left.sourceSelectorId !== right.sourceSelectorId
        || left.sourceContractVersion !== right.sourceContractVersion
        || left.observation.kind !== right.observation.kind
    ) {
        return false;
    }

    if (left.observation.kind === 'durablePush') {
        return right.observation.kind === 'durablePush'
            && left.observation.webhookEndpointId === right.observation.webhookEndpointId
            && left.observation.observationStartsAt === right.observation.observationStartsAt;
    }

    if (right.observation.kind !== 'checkpointedPull') return false;
    const leftWatcher = left.observation.watcher;
    const rightWatcher = right.observation.watcher;
    if (leftWatcher === null || rightWatcher === null) {
        return leftWatcher === rightWatcher;
    }
    return leftWatcher.machineInstallationId === rightWatcher.machineInstallationId
        && arePluginMachineMaterializationRefsEqual(leftWatcher, rightWatcher);
}

/**
 * List refreshes may retain same-revision private state only when the public
 * target and trigger still name that exact definition. This keeps the store
 * from composing a current list row with a stale direct detail.
 */
export function hasMatchingAutomationDefinitionSummary(
    left: Pick<AutomationDefinition, 'targetType' | 'trigger'>,
    right: Pick<AutomationDefinition, 'targetType' | 'trigger'>,
): boolean {
    if (left.targetType !== right.targetType || left.trigger.kind !== right.trigger.kind) {
        return false;
    }

    switch (left.trigger.kind) {
        case 'schedule':
            return right.trigger.kind === 'schedule'
                && sameScheduleTrigger(left.trigger, right.trigger);
        case 'manual':
            return right.trigger.kind === 'manual';
        case 'pluginEvent':
            return right.trigger.kind === 'pluginEvent'
                && samePluginEventTrigger(left.trigger, right.trigger);
    }

    return false;
}

function createScheduleDefinition(detail: ScheduleDetail): AutomationDefinitionAvailable<'schedule'> {
    const summary = summaryFromDetail(detail);
    return {
        ...summary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: detail,
        },
        linkedExistingSessionId: linkedExistingSessionId(detail),
    };
}

function createManualDefinition(detail: ManualDetail): AutomationDefinitionAvailable<'manual'> {
    const summary = summaryFromDetail(detail);
    return {
        ...summary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: detail,
        },
        linkedExistingSessionId: linkedExistingSessionId(detail),
    };
}

function createPluginEventDefinition(detail: PluginEventDetail): AutomationDefinitionAvailable<'pluginEvent'> {
    const summary = summaryFromDetail(detail);
    return {
        ...summary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: detail,
        },
        linkedExistingSessionId: linkedExistingSessionId(detail),
    };
}

function attachScheduleDetail(
    summary: ScheduleDefinition,
    detail: ScheduleDetail,
): AutomationDefinitionAvailable<'schedule'> {
    const currentSummary = currentSummaryFromDefinition(summary);
    const currentDetail = {
        ...detail,
        ...currentSummary,
    };
    return {
        ...currentSummary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: currentDetail,
        },
        linkedExistingSessionId: linkedExistingSessionId(currentDetail),
    };
}

function attachManualDetail(
    summary: ManualDefinition,
    detail: ManualDetail,
): AutomationDefinitionAvailable<'manual'> {
    const currentSummary = currentSummaryFromDefinition(summary);
    const currentDetail = { ...detail, ...currentSummary };
    return {
        ...currentSummary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: currentDetail,
        },
        linkedExistingSessionId: linkedExistingSessionId(currentDetail),
    };
}

function attachPluginEventDetail(
    summary: PluginEventDefinition,
    detail: PluginEventDetail,
): AutomationDefinitionAvailable<'pluginEvent'> {
    const currentSummary = currentSummaryFromDefinition(summary);
    const currentDetail = {
        ...detail,
        ...currentSummary,
    };
    return {
        ...currentSummary,
        detail: {
            kind: 'available',
            templateVersion: detail.templateVersion,
            value: currentDetail,
        },
        linkedExistingSessionId: linkedExistingSessionId(currentDetail),
    };
}

/**
 * Creates one safe, content-free store record from the list projection. The
 * bounded list already carries the owner-projected existing-Session
 * association, so a session-scoped consumer never has to read private
 * definition detail to answer an association question.
 */
export function createAutomationDefinitionSummary(
    summary: AutomationDefinitionListItem,
): AutomationDefinition {
    return {
        ...summary,
        detail: {
            kind: 'unloaded',
            templateVersion: summary.templateVersion,
        },
        linkedExistingSessionId: summary.existingSessionId,
    };
}

/** Projects a mutation/direct-read result into the same canonical store record. */
export function createAutomationDefinitionFromDetail(
    detail: AutomationDefinitionDetail,
): AutomationDefinition {
    if (isScheduleDetail(detail)) return createScheduleDefinition(detail);
    if (isManualDetail(detail)) return createManualDefinition(detail);
    return createPluginEventDefinition(detail);
}

/** A direct 409 must revoke the cached private content rather than reinterpret it as plaintext. */
export function markAutomationDefinitionContentUnavailable(
    summary: AutomationDefinition,
): AutomationDefinition {
    const currentSummary = currentSummaryFromDefinition(summary);
    return {
        ...currentSummary,
        detail: {
            kind: 'unavailable',
            templateVersion: summary.templateVersion,
            code: 'automation_stored_content_unavailable',
        },
        // Revoking unreadable private content must not also drop the bounded
        // association the definition owner already published.
        linkedExistingSessionId: currentSummary.existingSessionId,
    };
}

/**
 * Applies a direct response only when it is at least as current as the record
 * it would replace. This makes delayed route reads safe without a second cache.
 */
export function applyAutomationDefinitionDetail(
    current: AutomationDefinition | null | undefined,
    detail: AutomationDefinitionDetail,
    options: Readonly<{ replaceEqualRevision?: boolean }> = {},
): AutomationDefinition {
    if (!current) {
        return createAutomationDefinitionFromDetail(detail);
    }
    if (current.id !== detail.id || current.templateVersion > detail.templateVersion) {
        return current;
    }
    if (current.templateVersion < detail.templateVersion) {
        return createAutomationDefinitionFromDetail(detail);
    }
    if (current.detail.kind === 'unavailable') {
        return current;
    }
    if (options.replaceEqualRevision === true) {
        return createAutomationDefinitionFromDetail(detail);
    }
    if (current.detail.kind === 'available') {
        return current;
    }
    return attachAutomationDefinitionDetail(current, detail) ?? current;
}

/**
 * Attaches private content only after the direct endpoint proves that it
 * belongs to the summary's current Automation revision. A stale route result
 * is intentionally dropped rather than overwriting last-known-good content.
 */
export function attachAutomationDefinitionDetail(
    summary: AutomationDefinition,
    detail: AutomationDefinitionDetail,
): AutomationDefinition | null {
    if (
        detail.id !== summary.id
        || detail.templateVersion !== summary.templateVersion
        || detail.targetType !== summary.targetType
        || !hasConsistentAutomationDefinitionExecutionRecipe(detail)
    ) {
        return null;
    }

    if (isScheduleDetail(detail)) {
        return isScheduleDefinition(summary) && sameScheduleTrigger(summary.trigger, detail.trigger)
            ? attachScheduleDetail(summary, detail)
            : null;
    }
    if (isManualDetail(detail)) {
        return isManualDefinition(summary) ? attachManualDetail(summary, detail) : null;
    }
    return isPluginEventDefinition(summary) && samePluginEventTrigger(summary.trigger, detail.trigger)
        ? attachPluginEventDetail(summary, detail)
        : null;
}
