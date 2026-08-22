import {
    AutomationRunExecutionTargetV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    arePluginMachineExecutionOriginsEqual,
    type AutomationV3AssignmentInput,
    type ExecutionRunDetachedStartRequestV1,
    type MentionRefV1,
    type SessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol';

import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
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

function readCurrentAssignments(definition: AutomationDefinition | null): readonly AutomationV3AssignmentInput[] | null {
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
    const encryptionMode = await fetchAccountEncryptionMode(credentials);
    if (encryptionMode.mode !== 'plain') return unavailable('account');

    const currentDefinition = params.editTarget
        ? await sync.refreshAutomationDefinitionDetail(params.editTarget.automationId)
        : null;
    if (
        (params.editTarget && !isCurrentPluginEventAutomationDefinition(currentDefinition, params.editTarget))
        || !params.isCurrent()
    ) {
        return unavailable('edit');
    }
    const currentTarget = params.editTarget ? readCurrentTarget(currentDefinition) : null;
    if (params.editTarget && currentTarget?.kind !== params.targetKind) return unavailable('edit');

    const metadata = params.metadata ?? (currentDefinition?.detail.kind === 'available'
        ? {
            name: currentDefinition.detail.value.name,
            description: currentDefinition.detail.value.description,
            enabled: currentDefinition.detail.value.enabled,
        }
        : null);
    if (!metadata) return unavailable('metadata');

    const targetInput = params.targetKind === 'newSession'
        ? { newSessionSpawn: params.buildNewSessionSpawn(readCurrentNewSessionSpawn(currentDefinition)) }
        : params.targetKind === 'executionRun'
            ? { executionRun: params.buildExecutionRun() }
            : {};
    const target = params.resolveTarget(targetInput);
    if (!target || !params.isCurrent()) return unavailable('target');

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
    if (!preflightWatcherOrigin || !params.isCurrent()) return unavailable('watcher');
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
        || !params.isCurrent()
    ) {
        return unavailable('watcher');
    }

    // Editing the retained new-session arm preserves the server's existing
    // multi-machine topology. The other two arms resolve exactly one current
    // machine at submit time and therefore own one matching assignment.
    const assignments = params.editTarget && target.target.kind === 'newSession'
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

    if (params.editTarget) {
        const patch = buildPluginEventAutomationDefinitionPatchRequest({
            ...definitionInput,
            expectedTemplateVersion: params.editTarget.expectedTemplateVersion,
        });
        if (!patch || !params.isCurrent()) return unavailable('definition');
        await sync.updatePluginEventAutomationDefinition(params.editTarget.automationId, patch);
        await sync.refreshAutomations();
        return { kind: 'updated', automationId: params.editTarget.automationId };
    }

    const create = buildPluginEventAutomationDefinitionCreateRequest(definitionInput);
    if (!create || !params.isCurrent()) return unavailable('definition');
    await sync.createPluginEventAutomationDefinition(create);
    await sync.refreshAutomations();
    return { kind: 'created' };
}
