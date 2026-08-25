import {
    AutomationRunExecutionTargetV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    arePluginMachineExecutionOriginsEqual,
    type AutomationAssignmentInput,
    type ExecutionRunDetachedStartRequestV1,
    type MentionRefV1,
    type SessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol';

import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { sync } from '@/sync/sync';

import {
    buildPlainPluginEventAutomationExecutionRecipe,
    buildPluginEventAutomationDefinitionCreateRequest,
    buildPluginEventAutomationDefinitionPatchRequest,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationEditTarget,
} from './pluginEventAutomationDraft';
import { isPluginEventAutomationExecutionRunCapabilityCurrent } from './pluginEventAutomationExecutionCapability';
import type { PluginEventAutomationSubmissionSummary } from './pluginEventAutomationSubmissionConfirmation';
import type {
    PluginEventAutomationResolvedTarget,
    PluginEventAutomationTargetKind,
} from './pluginEventAutomationTarget';

type PluginEventAutomationMetadata = Readonly<{
    name: string;
    description: string | null;
    enabled: boolean;
}>;

export type PluginEventAutomationSubmitResult =
    | Readonly<{ kind: 'created' }>
    | Readonly<{ kind: 'updated'; automationId: string }>
    /** The author declined the final confirmation; nothing was written. */
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'account'
            | 'edit'
            | 'metadata'
            | 'target'
            | 'execution_capability'
            | 'watcher'
            | 'definition';
    }>;

function unavailable(
    reason: Extract<PluginEventAutomationSubmitResult, Readonly<{ kind: 'unavailable' }>>['reason'],
): PluginEventAutomationSubmitResult {
    return { kind: 'unavailable', reason };
}

function isValidEditTarget(
    target: PluginEventAutomationEditTarget | null | undefined,
): target is PluginEventAutomationEditTarget {
    return typeof target?.automationId === 'string'
        && target.automationId.trim().length > 0
        && target.automationId === target.automationId.trim()
        && Number.isSafeInteger(target.expectedTemplateVersion)
        && target.expectedTemplateVersion >= 0;
}

/**
 * List summaries never disclose the private Event source/configuration. An
 * update can only continue after the exact direct detail is current again.
 */
function isCurrentPluginEventAutomationDefinition(
    definition: AutomationDefinition | null,
    target: PluginEventAutomationEditTarget,
): boolean {
    if (
        !definition
        || definition.id !== target.automationId
        || definition.templateVersion !== target.expectedTemplateVersion
        || definition.trigger.kind !== 'pluginEvent'
        || definition.detail.kind !== 'available'
        || definition.detail.templateVersion !== target.expectedTemplateVersion
    ) {
        return false;
    }
    const detail = definition.detail.value;
    return detail.id === target.automationId
        && detail.templateVersion === target.expectedTemplateVersion
        && detail.trigger.kind === 'pluginEvent';
}

function readCurrentTarget(definition: AutomationDefinition | null) {
    if (
        !definition
        || definition.trigger.kind !== 'pluginEvent'
        || definition.detail.kind !== 'available'
    ) {
        return null;
    }
    const parsed = AutomationRunExecutionTargetV1Schema.safeParse(definition.detail.value.executionRecipe?.target);
    return parsed.success ? parsed.data : null;
}

function readCurrentNewSessionSpawn(definition: AutomationDefinition | null): SessionServerStartSpawnDraftV1 | null {
    const target = readCurrentTarget(definition);
    if (target?.kind !== 'newSession') return null;
    const parsed = SessionServerStartSpawnDraftV1Schema.safeParse(target.spawn);
    return parsed.success ? parsed.data : null;
}

function readCurrentAssignments(definition: AutomationDefinition | null): readonly AutomationAssignmentInput[] | null {
    if (
        !definition
        || definition.trigger.kind !== 'pluginEvent'
        || definition.detail.kind !== 'available'
    ) {
        return null;
    }
    return definition.detail.value.assignments.map(({ machineId, enabled, priority }) => ({
        machineId,
        enabled,
        priority,
    }));
}

function normalizeServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

async function hasCurrentExecutionRunCapability(params: Readonly<{
    machineId: string;
    serverId: string;
    request: ExecutionRunDetachedStartRequestV1;
}>): Promise<boolean> {
    const result = await machineCapabilitiesDetect(
        params.machineId,
        { requests: [{ id: 'tool.executionRuns' }] },
        { serverId: params.serverId },
    );
    const capability = result.supported ? result.response.results['tool.executionRuns'] : null;
    return capability?.ok === true && isPluginEventAutomationExecutionRunCapabilityCurrent({
        capability: capability.data,
        backendTarget: params.request.backendTarget,
    });
}

export async function submitPluginEventAutomation(params: Readonly<{
    draft: PluginEventAutomationCreateDraft;
    editTarget: PluginEventAutomationEditTarget | null;
    automationEditId: string | null | undefined;
    metadata: PluginEventAutomationMetadata | null;
    prompt: string;
    /** The composer references picked beside `prompt`, persisted with it. */
    mentions?: readonly MentionRefV1[];
    targetKind: PluginEventAutomationTargetKind;
    executionTargetServerId: string | null | undefined;
    buildNewSessionSpawn: (currentSpawn: SessionServerStartSpawnDraftV1 | null) => SessionServerStartSpawnDraftV1 | null;
    buildExecutionRun: () => Readonly<{
        machineId: string | null;
        request: ExecutionRunDetachedStartRequestV1 | null;
    }> | null;
    resolveTarget: (input: Readonly<{
        newSessionSpawn?: SessionServerStartSpawnDraftV1 | null;
        executionRun?: Readonly<{
            machineId: string | null;
            request: ExecutionRunDetachedStartRequestV1 | null;
        }> | null;
    }>) => PluginEventAutomationResolvedTarget | null;
    /**
     * The one final comprehension checkpoint. It is required rather than
     * optional so no authoring caller can write an Event Automation definition
     * without showing the resolved trigger, watcher, executor, target and
     * permission effects it is about to persist.
     */
    confirmSubmission: (summary: PluginEventAutomationSubmissionSummary) => Promise<boolean>;
    isCurrent: () => boolean;
}>): Promise<PluginEventAutomationSubmitResult> {
    const editId = typeof params.automationEditId === 'string' ? params.automationEditId.trim() : '';
    const isEdit = editId.length > 0 || params.editTarget !== null;
    if (
        (isEdit && (!isValidEditTarget(params.editTarget) || params.editTarget.automationId !== editId))
        || !params.draft
    ) {
        return unavailable('edit');
    }

    const credentials = sync.getCredentials();
    if (!credentials) return unavailable('account');
    // The caller's fence is keyed on the launch target, so an Account switch on
    // the same server is invisible to it. Every step below writes through the
    // CURRENT Account while the credential and encryption mode admitted here
    // belong to the Account captured now, so both must stay current together.
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) return unavailable('account');
    const isCurrent = (): boolean => params.isCurrent() && accountLifetime.isCurrent();

    const encryptionMode = await fetchAccountEncryptionMode(credentials);
    if (encryptionMode.mode !== 'plain' || !isCurrent()) return unavailable('account');

    const currentDefinition = params.editTarget
        ? await sync.refreshAutomationDefinitionDetail(params.editTarget.automationId)
        : null;
    if (
        (params.editTarget && !isCurrentPluginEventAutomationDefinition(currentDefinition, params.editTarget))
        || !isCurrent()
    ) {
        return unavailable('edit');
    }
    // AUTO-19/r0.28: a strict patch replaces the whole recipe for future
    // Runs, so an edit may move an Automation between the three approved
    // target arms. Already-admitted Runs keep the recipe they were frozen
    // with; only later admission uses the arm saved here.
    const currentTarget = params.editTarget ? readCurrentTarget(currentDefinition) : null;

    const metadata = params.metadata ?? (currentDefinition?.detail.kind === 'available'
        ? {
            name: currentDefinition.detail.value.name,
            description: currentDefinition.detail.value.description,
            enabled: currentDefinition.detail.value.enabled,
        }
        : null);
    if (!metadata) return unavailable('metadata');

    const targetInput = params.targetKind === 'newSession'
        ? {
            newSessionSpawn: params.buildNewSessionSpawn(
                // Only an unchanged new-session arm has a current spawn to
                // refine; a switched arm starts from the composer's own input.
                currentTarget?.kind === 'newSession' ? readCurrentNewSessionSpawn(currentDefinition) : null,
            ),
        }
        : params.targetKind === 'executionRun'
            ? { executionRun: params.buildExecutionRun() }
            : {};
    const target = params.resolveTarget(targetInput);
    if (!target || !isCurrent()) return unavailable('target');

    if (target.target.kind === 'executionRun') {
        const serverId = normalizeServerId(params.executionTargetServerId);
        if (!serverId || !await hasCurrentExecutionRunCapability({
            machineId: target.assignmentMachineId,
            serverId,
            request: target.target.request,
        })) {
            return unavailable('execution_capability');
        }
    }

    const templateVersion = params.editTarget
        ? params.editTarget.expectedTemplateVersion + 1
        : 1;
    if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) return unavailable('definition');
    const executionRecipe = buildPlainPluginEventAutomationExecutionRecipe({
        templateVersion,
        prompt: params.prompt,
        ...(params.mentions ? { mentions: params.mentions } : {}),
        target: target.target,
    });
    if (!executionRecipe) return unavailable('target');

    const preflightWatcherOrigin = params.draft.resolveFreshWatcherOrigin();
    if (!preflightWatcherOrigin || !isCurrent()) return unavailable('watcher');
    const projection = await loadDaemonMergedProjectionInputs({
        machineId: preflightWatcherOrigin.machineTarget.target.machineId,
        serverId: preflightWatcherOrigin.machineTarget.serverId,
        staleMs: 0,
    });
    const freshWatcherOrigin = params.draft.resolveFreshWatcherOrigin();
    const eligibleEvents = projection?.automationEligibleEvents;
    if (
        !freshWatcherOrigin
        || !eligibleEvents
        || !arePluginMachineExecutionOriginsEqual(preflightWatcherOrigin.origin, freshWatcherOrigin.origin)
        || preflightWatcherOrigin.machineTarget.serverId !== freshWatcherOrigin.machineTarget.serverId
        || preflightWatcherOrigin.machineTarget.target.serverIdentityId
            !== freshWatcherOrigin.machineTarget.target.serverIdentityId
        || preflightWatcherOrigin.machineTarget.target.machineId
            !== freshWatcherOrigin.machineTarget.target.machineId
        || !isCurrent()
    ) {
        return unavailable('watcher');
    }

    // Editing the retained new-session arm preserves the server's existing
    // multi-machine topology. The other two arms resolve exactly one current
    // machine at submit time and therefore own one matching assignment.
    const assignments = params.editTarget
        && target.target.kind === 'newSession'
        && currentTarget?.kind === 'newSession'
        ? readCurrentAssignments(currentDefinition)
        : [{ machineId: target.assignmentMachineId, enabled: true, priority: 100 }];
    if (!assignments) return unavailable('definition');
    const definitionInput = {
        name: metadata.name,
        description: metadata.description,
        enabled: metadata.enabled,
        eligibleEvents,
        draft: params.draft.draft,
        watcherOrigin: freshWatcherOrigin.origin,
        executionRecipe,
        assignments,
    };

    // Confirm after every fact is resolved and before the first durable write,
    // so the summary describes exactly what lands. The currentness checks below
    // still run afterwards, so a confirmation the author sat on cannot write a
    // stale definition.
    const confirmed = await params.confirmSubmission({
        mode: params.editTarget ? 'edit' : 'create',
        automationName: metadata.name,
        enabled: metadata.enabled,
        trigger: {
            pluginId: params.draft.draft.eventRef.pluginId,
            eventLocalId: params.draft.draft.eventRef.localId,
        },
        observation: params.draft.draft.observation.kind,
        watcherMachineId: freshWatcherOrigin.machineTarget.target.machineId,
        executorMachineIds: assignments.map((assignment) => assignment.machineId),
        target: target.target.kind === 'executionRun'
            ? { kind: 'executionRun', permissionMode: target.target.request.permissionMode }
            : { kind: target.target.kind },
    });
    if (!confirmed) return { kind: 'cancelled' };
    if (!isCurrent()) return unavailable('definition');

    if (params.editTarget) {
        const patch = buildPluginEventAutomationDefinitionPatchRequest({
            ...definitionInput,
            expectedTemplateVersion: params.editTarget.expectedTemplateVersion,
        });
        if (!patch || !isCurrent()) return unavailable('definition');
        await sync.updatePluginEventAutomationDefinition(params.editTarget.automationId, patch);
        await sync.refreshAutomations();
        return { kind: 'updated', automationId: params.editTarget.automationId };
    }

    const create = buildPluginEventAutomationDefinitionCreateRequest(definitionInput);
    if (!create || !isCurrent()) return unavailable('definition');
    await sync.createPluginEventAutomationDefinition(create);
    await sync.refreshAutomations();
    return { kind: 'created' };
}
