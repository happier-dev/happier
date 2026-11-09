import { safeParse, type core } from 'zod/mini';
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
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { describeProjectCommandSource, joinProjectFiles } from './projectScriptPresentation';

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

async function readProjectSetupAgentGuidanceCurrent(input: ProjectSetupAgentGuidanceInput, observeDestination: boolean) {
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
            request: unknown, schema: core.$ZodType<T>): Promise<{ ok: true; value: T } | ActionExecuteFailure> {
            const result = await executor.execute(actionId, request, context);
            // Only redacted public diagnostics enter the user prompt, not failure details or transport prose.
            if (!result.ok) return { ok: false, errorCode: result.errorCode, error: result.errorCode };
            if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
                return { ok: false, errorCode: 'approval_required', error: 'approval_required' };
            }
            const parsed = safeParse(schema, result.result);
            return parsed.success ? { ok: true, value: parsed.data }
                : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        }
        const beforeReads = refusal();
        if (beforeReads) return beforeReads;
        const address = { serverId: input.workspace.serverId, refId: input.workspace.workspaceId };
        const [inspection, preferences] = await Promise.all([
            read('projects.inspect', { workspace: input.workspace, read: { kind: 'guidance' } }, ProjectDefinitionInspectOutputSchema),
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
        const services = document?.status === 'valid'
            ? Object.entries(document.manifest.services ?? {}).map(([name, declaration]) => ({ name, ...declaration }))
            : document === null ? [] : null;
        const configured = preferences.ok && preferences.value.status === 'ready' ? preferences.value.preference.destination : undefined;
        const destination = configured && observeDestination ? {
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
            ...(inspection.ok ? { detection: inspection.value.detection, detectionSummary: inspection.value.detectionSummary } : {}),
            workerPreferences: preferences.ok ? preferences.value : preferences,
            scripts,
            services,
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

/** The editable request contains a short observation, never the qualified inspection DTO. */
function describeSetupAuthoringFacts(guidance: ProjectSetupAgentGuidance): string {
    const summary = guidance.detectionSummary;
    const detectedScripts = summary?.scripts ?? 0;
    const detectedServices = summary?.services ?? 0;
    const scriptSources = (guidance.scripts ?? []).map(script => script.source);
    const serviceSources = (guidance.services ?? []).map(service => service.source);
    const scriptCount = detectedScripts || scriptSources.length;
    const serviceCount = detectedServices || serviceSources.length;
    const sourceFiles = (sources: typeof scriptSources) => sources
        .map(source => describeProjectCommandSource(source).file).filter(file => file !== null);
    const files = joinProjectFiles([
        ...(summary && detectedScripts > 0 ? summary.files.filter(file => file.scripts > 0).map(file => file.file) : sourceFiles(scriptSources)),
        ...(summary && detectedServices > 0 ? summary.files.filter(file => file.services > 0).map(file => file.file) : sourceFiles(serviceSources)),
    ]);
    return [
        // A zero count is not an observation the agent needs; an empty checkout seeds the request alone.
        [...(scriptCount > 0 ? [t('projects.authoring.scriptsCount', { count: scriptCount })] : []),
            ...(serviceCount > 0 ? [t('projects.authoring.servicesCount', { count: serviceCount })] : []),
            ...(files ? [t('projects.scripts.foundIn', { files })] : [])].join(' · '),
        ...(guidance.detection?.coverage === 'partial' ? [t('projects.scripts.definition.partial')] : []),
        ...('status' in guidance.workerPreferences && guidance.workerPreferences.status === 'ready'
            ? [] : [t('projectWorkers.policyUnavailable')]),
    ].filter(line => line.length > 0).join('\n');
}

/** GUIDE disclosure and ordinary authoring consume this same read-only factual owner. */
export async function readProjectSetupAgentGuidance(input: ProjectSetupAgentGuidanceInput): Promise<ProjectSetupAgentGuidanceResult> {
    return await readProjectSetupAgentGuidanceCurrent(input, true);
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
        const observed = await readProjectSetupAgentGuidanceCurrent(input, false);
        if (observed.kind !== 'ready') return { ok: true, result: observed };
        if ('ok' in observed.guidance.definition && !observed.guidance.definition.ok) return observed.guidance.definition;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (input.signal?.aborted) return { ok: true, result: { kind: 'unavailable', reason: 'aborted' } };
        if (!lifetime.isCurrent()) return { ok: true, result: { kind: 'stale', reason: 'host_retired' } };
        const destination = resolveCurrentProjectAuthoringReturn(origin);
        if (destination.kind !== 'ready') {
            return { ok: true, result: { kind: 'unavailable', reason: 'origin_unavailable' } };
        }
        const request: SessionAuthoringOpenV1 = { seed: {
            sessionName: t('projects.authoring.draftTitle', { project: resolveWorkspaceRefDisplayName(destination.workspaceRef) }),
            prompt: [t('projects.authoring.prompt'), describeSetupAuthoringFacts(observed.guidance)].filter(Boolean).join('\n\n'),
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
