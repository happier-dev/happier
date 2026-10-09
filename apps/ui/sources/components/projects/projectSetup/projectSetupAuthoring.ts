import type { z } from 'zod';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { MachinePoolResolveResultV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { resolveProjectExecutionChoiceV1, type ProjectWorkerPreferenceAvailabilityV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { PluginUiNewSessionSeedOriginV1, SessionAuthoringOpenV1 } from '@happier-dev/protocol/plugins/ui';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveCurrentProjectAuthoringReturn } from '@/components/projects/detail/projectRouteState';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

export type ProjectSetupAuthoringInput = Readonly<{
    workspace: WorkspaceAddressV1;
    page?: PluginUiNewSessionSeedOriginV1['page'];
    comparisonId?: string;
    profileId?: string;
    signal?: AbortSignal;
}>;

export type ProjectSetupAgentGuidanceInput = Pick<ProjectSetupAuthoringInput, 'workspace' | 'page' | 'comparisonId' | 'signal'>;
type ProjectSetupAgentGuidanceRefusal = Readonly<{ kind: 'stale'; reason: 'host_retired' }>
    | Readonly<{ kind: 'unavailable'; reason: 'aborted' | 'origin_unavailable' }>;

async function readProjectSetupAgentGuidanceCurrent(input: ProjectSetupAgentGuidanceInput) {
    if (input.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' } as const;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return { kind: 'stale', reason: 'host_retired' } as const;
    const origin: PluginUiNewSessionSeedOriginV1 = {
        kind: 'project', accountId: lifetime.scope.accountId, workspace: input.workspace,
        page: input.page ?? 'scripts', ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
    };
    if (resolveCurrentProjectAuthoringReturn(origin).kind !== 'ready') {
        return { kind: 'unavailable', reason: 'origin_unavailable' } as const;
    }
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    if (!lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired' } as const;
    try {
        const executor = createDefaultActionExecutor();
        const context = {
            surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId,
            ...(input.signal ? { signal: input.signal } : {}),
        } as const;
        const refusal = (): ProjectSetupAgentGuidanceRefusal | null => input.signal?.aborted
            ? { kind: 'unavailable', reason: 'aborted' }
            : !lifetime.isCurrent() ? { kind: 'stale', reason: 'host_retired' }
                : resolveCurrentProjectAuthoringReturn(origin).kind !== 'ready'
                    ? { kind: 'unavailable', reason: 'origin_unavailable' } : null;
        async function read<T>(actionId: 'projects.inspect' | 'projects.worker.preferences.get' | 'projects.worker.status' | 'machines.pools.resolve',
            request: unknown, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | ActionExecuteFailure> {
            const result = await executor.execute(actionId, request, context);
            // Only redacted public diagnostics enter the user prompt, not failure details or transport prose.
            if (!result.ok) return { ok: false, errorCode: result.errorCode, error: result.errorCode };
            if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
                return { ok: false, errorCode: 'approval_required', error: 'approval_required' };
            }
            const parsed = schema.safeParse(result.result);
            return parsed.success ? { ok: true, value: parsed.data }
                : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        }
        const beforeReads = refusal();
        if (beforeReads) return beforeReads;
        const address = { serverId: input.workspace.serverId, refId: input.workspace.workspaceId };
        const [inspection, preferences] = await Promise.all([
            read('projects.inspect', { workspace: input.workspace }, ProjectDefinitionInspectOutputSchema),
            read('projects.worker.preferences.get', { workspace: address }, ProjectWorkerActionOutputSchemasV1['projects.worker.preferences.get']),
        ]);
        const afterReads = refusal();
        if (afterReads) return afterReads;
        const availability: ProjectWorkerPreferenceAvailabilityV1 = preferences.ok
            ? preferences.value.status === 'ready' ? { status: 'ready', value: preferences.value.preference } : preferences.value
            : { status: 'unavailable' };
        const document = inspection.ok ? inspection.value.definition.document : undefined;
        const scripts = document?.status === 'valid' ? Object.entries(document.manifest.scripts ?? {}).map(([name, declaration]) => {
            const execution = declaration.execution ?? 'primary';
            return { name, ...declaration, execution, resolution: resolveProjectExecutionChoiceV1({
                execution, scriptName: name, sourceMachineId: input.workspace.machineId, preference: availability,
            }) };
        }) : document === null ? [] : null;
        const configured = preferences.ok && preferences.value.status === 'ready' ? preferences.value.preference.destination : undefined;
        const destination = configured ? {
            configured,
            observation: configured.kind === 'machine'
                ? await read('projects.worker.status', { workspace: address, destination: configured, purpose: 'finite' }, ProjectWorkerActionOutputSchemasV1['projects.worker.status'])
                : await read('machines.pools.resolve', { poolId: configured.poolId, requestKey: randomUUID(), purpose: 'finite', workspace: address }, MachinePoolResolveResultV1Schema),
        } : null;
        const beforePublication = refusal();
        if (beforePublication) return beforePublication;
        // Demand-read advisory facts, not Session instructions, accepted placement or consent.
        const facts = {
            advisory: true,
            sourceWorkspace: input.workspace,
            definition: inspection.ok ? { basis: inspection.value.definition.basis, status: document?.status ?? 'absent',
                ...(document ? { diagnostics: document.diagnostics } : {}) } : inspection,
            ...(inspection.ok ? { detection: inspection.value.detection, importCandidates: inspection.value.importCandidates,
                ...(inspection.value.commands ? { commands: inspection.value.commands } : {}),
                ...(inspection.value.tools ? { tools: inspection.value.tools } : {}) } : {}),
            workerPreferences: preferences.ok ? preferences.value : preferences,
            scripts,
            destination: destination ? { configured: destination.configured,
                observation: destination.observation.ok ? destination.observation.value : destination.observation }
                : preferences.ok && preferences.value.status === 'ready' ? null
                    : { status: preferences.ok ? preferences.value.status : 'unavailable' },
            adHoc: { actionId: 'projects.compute.exec', approval: 'configured_action_policy',
                resolution: resolveProjectExecutionChoiceV1({ execution: 'portable', adHoc: true,
                    sourceMachineId: input.workspace.machineId, preference: availability }) },
        } as const;
        return { kind: 'ready', guidance: facts } as const;
    } catch (error) {
        if (input.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' } as const;
        if (!lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired' } as const;
        throw error;
    }
}

export type ProjectSetupAgentGuidanceResult = Awaited<ReturnType<typeof readProjectSetupAgentGuidanceCurrent>>;
export type ProjectSetupAgentGuidance = Extract<ProjectSetupAgentGuidanceResult, { kind: 'ready' }>['guidance'];

/** GUIDE disclosure and ordinary authoring consume this same read-only factual owner. */
export async function readProjectSetupAgentGuidance(input: ProjectSetupAgentGuidanceInput): Promise<ProjectSetupAgentGuidanceResult> {
    return await readProjectSetupAgentGuidanceCurrent(input);
}

/** Scripts empty and Overview Setup are thin entries to the real presentation Action. */
export async function openProjectSetupAuthoring(input: ProjectSetupAuthoringInput): Promise<ActionExecuteResult> {
    if (input.signal?.aborted) return { ok: true, result: { kind: 'unavailable', reason: 'aborted' } };
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return { ok: true, result: { kind: 'stale', reason: 'host_retired' } };
    const origin: PluginUiNewSessionSeedOriginV1 = {
        kind: 'project', accountId: lifetime.scope.accountId, workspace: input.workspace,
        page: input.page ?? 'scripts', ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
    };
    try {
        const observed = await readProjectSetupAgentGuidance(input);
        if (observed.kind !== 'ready') return { ok: true, result: observed };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (input.signal?.aborted) return { ok: true, result: { kind: 'unavailable', reason: 'aborted' } };
        if (!lifetime.isCurrent()) return { ok: true, result: { kind: 'stale', reason: 'host_retired' } };
        if (resolveCurrentProjectAuthoringReturn(origin).kind !== 'ready') {
            return { ok: true, result: { kind: 'unavailable', reason: 'origin_unavailable' } };
        }
        const request: SessionAuthoringOpenV1 = { seed: {
            prompt: `${t('projects.authoring.prompt')}\n\n${JSON.stringify(observed.guidance)}`,
            placement: { kind: 'exactTarget', serverId: input.workspace.serverId,
                machineId: input.workspace.machineId, directory: input.workspace.rootPath },
            origin,
            ...(input.profileId ? { profileId: input.profileId } : {}),
        } };
        const result = await createDefaultActionExecutor().execute('session.authoring.open', request, {
            surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId, ...(input.signal ? { signal: input.signal } : {}),
        });
        return !result.ok && result.errorCode === 'cancelled' && input.signal?.aborted
            ? { ok: true, result: { kind: 'unavailable', reason: 'aborted' } }
            : result;
    } catch (error) {
        if (input.signal?.aborted) return { ok: true, result: { kind: 'unavailable', reason: 'aborted' } };
        if (!lifetime.isCurrent()) return { ok: true, result: { kind: 'stale', reason: 'host_retired' } };
        throw error;
    }
}
