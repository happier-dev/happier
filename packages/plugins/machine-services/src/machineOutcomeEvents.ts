import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { admitNativeActionCompletionObservation } from './eventCompletion.js';
export { projectNativeEventObservationAdmissionInput } from './eventCompletion.js';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createMachineOutcomeSummaryReader } from './machineOutcomeSummaryReader.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { SCM_WORKTREE_CREATE_ACTION_ID_V1, SCM_WORKTREE_REMOVE_ACTION_ID_V1, PROJECT_PREPARE_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, BackupOutcomeEventV1ProtocolSchema, MachinePressureEventV1ProtocolSchema, WorktreeRemovedEventV1ProtocolSchema, WorktreeCreatedEventV1ProtocolSchema,
    GuardStoppedEventV1ProtocolSchema, ConnectedServiceQuotaEventV1ProtocolSchema, ConnectedServiceCredentialHealthEventV1ProtocolSchema, ProjectSetupSettledEventV1ProtocolSchema,
    createPluginEventAutomationSetupResultV1JsonSchema, type MachineServiceObservationV1,
    machineOutcomeSummaryAddress, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1, type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';

const pluginId = 'happier.machine.services';
const id = defineProtocolString({ minLength: 1 });
const target = { v: defineProtocolLiteral(1), serverId: id, machineId: id };
const machineSetup = defineProtocolObject(target, { policy: 'closed' });
const accountSetup = defineProtocolObject({ v: defineProtocolLiteral(1), serverId: id }, { policy: 'closed' });
const sourceSchema = defineProtocolObject({ v: defineProtocolLiteral(1), serverId: id,
    machineId: id.optional(), environmentId: id.optional() }, { policy: 'closed' });
type Source = ReturnType<typeof sourceSchema.parse>;
const descriptors = {
    'backup-failed': { subjectKinds: ['backup', 'environment', 'machine'], scope: 'backup', completionOutcome: 'failed', completesActionIds: [DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1], key: 'backupFailed', title: 'Backup failed', description: 'A backup run settled as failed.', schema: BackupOutcomeEventV1ProtocolSchema },
    'backup-succeeded': { subjectKinds: ['backup', 'environment', 'machine'], scope: 'backup', completionOutcome: 'succeeded', completesActionIds: [DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1], key: 'backupSucceeded', title: 'Backup succeeded', description: 'A backup run settled successfully.', schema: BackupOutcomeEventV1ProtocolSchema },
    'machine-pressure-changed': { subjectKinds: ['machine'], scope: 'machine', key: 'machinePressureChanged', title: 'Machine pressure changed',
        description: 'An enabled memory, CPU or disk alert fired or recovered.', schema: MachinePressureEventV1ProtocolSchema },
    'worktree-created': { subjectKinds: ['machine', 'project'], scope: 'machine', completionOutcome: 'succeeded', completesActionIds: [SCM_WORKTREE_CREATE_ACTION_ID_V1], key: 'worktreeCreated', title: 'Worktree created',
        description: 'A new worktree was created from the source repository.', schema: WorktreeCreatedEventV1ProtocolSchema },
    'worktree-removed': { subjectKinds: ['machine', 'project'], scope: 'machine', completionOutcome: 'succeeded', completesActionIds: [SCM_WORKTREE_REMOVE_ACTION_ID_V1], key: 'worktreeRemoved', title: 'Worktree removed',
        description: 'An accepted worktree was deleted or retired.', schema: WorktreeRemovedEventV1ProtocolSchema },
    'guard-stopped': { subjectKinds: ['machine', 'session'], scope: 'machine', key: 'guardStopped', title: 'Guard stopped a Session',
        description: 'The Machine Guard retained a stopped Session fact.', schema: GuardStoppedEventV1ProtocolSchema },
    'connected-account-quota-changed': { subjectKinds: ['machine'], scope: 'machine', key: 'connectedAccountQuotaChanged', title: 'Connected Account quota changed',
        description: 'A Connected Account group became blocked or recovered.', schema: ConnectedServiceQuotaEventV1ProtocolSchema },
    'connected-account-credential-attention': { subjectKinds: ['machine'], scope: 'machine', key: 'connectedAccountCredentialAttention', title: 'Connected Account needs attention',
        description: 'Persisted credential health entered or changed an attention state.', schema: ConnectedServiceCredentialHealthEventV1ProtocolSchema },
    'project-setup-finished': { subjectKinds: ['project', 'machine'], scope: 'machine', completionOutcome: 'succeeded', completesActionIds: [PROJECT_PREPARE_ACTION_ID_V1], key: 'projectSetupFinished', title: 'Project setup finished',
        description: 'An accepted Project setup finished.', schema: ProjectSetupSettledEventV1ProtocolSchema },
    'project-setup-failed': { subjectKinds: ['project', 'machine'], scope: 'machine', completionOutcome: 'failed', completesActionIds: [PROJECT_PREPARE_ACTION_ID_V1], key: 'projectSetupFailed', title: 'Project setup failed',
        description: 'An accepted Project setup failed.', schema: ProjectSetupSettledEventV1ProtocolSchema },
} as const;
type EventId = keyof typeof descriptors;
const isEventId = (value: string): value is EventId => Object.hasOwn(descriptors, value);
const eventIds = Object.keys(descriptors) as EventId[];
const usesRetainedSummary = (event: EventId) => descriptors[event].scope === 'backup' || event === 'machine-pressure-changed';
const setupFor = (event: EventId) => usesRetainedSummary(event) ? accountSetup : machineSetup;
function projectFact(fact: MachineServiceObservationV1) {
    switch (fact.kind) {
        case 'backup': return { serverId: fact.serverId, machineId: fact.machineId, environmentId: fact.environmentId,
            event: fact.state === 'failed' ? 'backup-failed' as const : 'backup-succeeded' as const,
            occurredAt: fact.occurredAt, identity: [fact.operationId], payload: fact };
        case 'pressure': return { serverId: fact.serverId, machineId: fact.machineId,
            event: 'machine-pressure-changed' as const, occurredAt: fact.episode.at,
            identity: [fact.episode.rule, fact.episode.volumeId ?? '', fact.episode.state, String(fact.episode.at)], payload: fact };
        case 'worktreeCreated': return { serverId: fact.serverId, machineId: fact.creation.machineId,
            event: 'worktree-created' as const, occurredAt: fact.occurredAt, identity: [fact.creation.operationId], payload: fact.creation };
        case 'worktreeRemoved': return { serverId: fact.serverId, machineId: fact.removal.machineId,
            event: 'worktree-removed' as const, occurredAt: fact.occurredAt, identity: [fact.removal.operationId], payload: fact.removal };
        case 'guard_stop': return { serverId: fact.serverId, machineId: fact.machineId,
            event: 'guard-stopped' as const, occurredAt: fact.settledAt ?? fact.at,
            identity: [fact.sessionId, fact.rule, String(fact.at)], payload: fact };
        case 'connected_service_quota': return { serverId: fact.serverId, machineId: fact.machineId,
            event: 'connected-account-quota-changed' as const, occurredAt: fact.occurredAt,
            identity: [fact.serviceId, fact.groupId, fact.profileId ?? '', fact.phase, fact.cycleId ?? '', fact.issueFingerprint], payload: fact };
        case 'credential_health': return { serverId: fact.serverId, machineId: fact.machineId,
            event: 'connected-account-credential-attention' as const, occurredAt: fact.occurredAt,
            identity: [fact.account.service.pluginId, fact.account.service.localId, fact.account.accountId,
                fact.status, fact.reason ?? '', String(fact.occurredAt)], payload: fact };
        case 'projectSetupSettled': return { serverId: fact.serverId, machineId: fact.machineId,
            event: fact.settlement.outcome === 'finished' ? 'project-setup-finished' as const : 'project-setup-failed' as const,
            occurredAt: fact.occurredAt, identity: [fact.settlement.operationId], payload: fact.settlement };
    }
}
export const machineOutcomeEventActions = Object.fromEntries(eventIds.map(event => [event + '/setup', {
    title: usesRetainedSummary(event) ? 'Choose Home' : 'Choose Machine',
    execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setupFor(event),
    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceSchema.jsonSchema),
    async run(value: unknown, context: PluginInvocationContext) {
        const selected = usesRetainedSummary(event) ? accountSetup.parse(value) : machineSetup.parse(value);
        const sourceConfig = sourceSchema.parse(selected);
        if (sourceConfig.machineId !== undefined) {
            const read = await context.services.actions.execute('machines.resources.policy.get', {
                serverId: sourceConfig.serverId, machineId: sourceConfig.machineId,
            }, { signal: context.signal });
            if (!('status' in read) || read.status !== 'ready') throw new PluginError({ code: 'target_unavailable', message: 'The Machine resource policy is unavailable.' });
        }
        return { v: 1 as const, sourceInstanceId: 'machine-event:' + computeCanonicalDomainSeparatedDigest('happier.machine.event-source.v1',
            [sourceConfig.serverId, sourceConfig.machineId ?? '', sourceConfig.environmentId ?? '', event]),
            sourceContractVersion: 1, sourceConfig, displayLabel: sourceConfig.environmentId ?? sourceConfig.machineId ?? 'Machine resources' };
    },
}]));
export const machineOutcomeEvents = Object.fromEntries(eventIds.map(event => {
    const descriptor = descriptors[event];
    return [event, { declaration: { kind: 'event' as const,
        title: { key: 'machineServices.events.' + descriptor.key + '.title', fallback: descriptor.title },
        description: { key: 'machineServices.events.' + descriptor.key + '.description', fallback: descriptor.description },
        payloadSchema: descriptor.schema.jsonSchema, automation: { v: 1 as const, eligible: true as const,
            subjectKinds: descriptor.subjectKinds,
            ...('completesActionIds' in descriptor ? { completesActionIds: [...descriptor.completesActionIds], completionOutcome: descriptor.completionOutcome } : {}), source: {
            sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: sourceSchema.jsonSchema,
            setupActionRef: { pluginId, localId: event + '/setup' },
        } },
    } }];
}));

/** Producer associations become canonical contexts once, before admission. */
function subjectContextsFor(fact: MachineServiceObservationV1): NonNullable<PluginEventObservationV1['subjectContexts']> {
    const machineId = fact.kind === 'worktreeRemoved' ? fact.removal.machineId
        : fact.kind === 'worktreeCreated' ? fact.creation.machineId : fact.machineId;
    const contexts: NonNullable<PluginEventObservationV1['subjectContexts']>[number][] = [
        { role: 'context', subject: { kind: 'machine', serverId: fact.serverId, machineId } },
    ];
    const project = fact.kind === 'worktreeRemoved' ? fact.removal.project
        : fact.kind === 'worktreeCreated' ? fact.creation.project
        : fact.kind === 'projectSetupSettled' ? fact.settlement.project : null;
    if (project) contexts.push({ role: 'context', subject: {
        kind: 'project', serverId: project.serverId, projectKey: project.projectId,
    } });
    if (fact.kind === 'guard_stop') contexts.push({ role: 'context', subject: {
        kind: 'session', serverId: fact.serverId, sessionId: fact.sessionId,
    } });
    if (fact.kind === 'backup') contexts.push(
        { role: 'operand', subject: { kind: 'backup', serverId: fact.serverId, environmentId: fact.environmentId } },
        { role: 'context', subject: { kind: 'environment', serverId: fact.serverId, environmentId: fact.environmentId } },
    );
    return contexts;
}

/** One projection for ordinary Event sources and finite host publication. */
export function projectMachineServiceObservation(payload: MachineServiceObservationV1,
    observedAt: number): PluginEventObservationV1 | null {
    const fact = projectFact(payload);
    if (!fact) return null;
    const originRunId = payload.kind === 'projectSetupSettled' ? payload.settlement.originRunId
        : payload.kind === 'worktreeRemoved' ? payload.removal.originRunId
        : payload.kind === 'worktreeCreated' ? payload.creation.originRunId
        : payload.kind === 'backup' ? payload.originRunId : undefined;
    return { eventRef: { pluginId, localId: fact.event },
        sourceInstanceId: 'machine-completion:' + computeCanonicalDomainSeparatedDigest('happier.machine.completion-source.v1',
            [fact.serverId, fact.machineId, fact.event]), sourceContractVersion: 1,
        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.machine.event-occurrence.v1',
            [fact.serverId, fact.machineId, fact.event, ...fact.identity]),
        occurredAt: fact.occurredAt, observationReceivedAt: observedAt, observedDelta: 1,
        subjectContexts: subjectContextsFor(payload), payload: projectNativeJsonValueForTransport(fact.payload),
        ...(originRunId ? { originRunId } : {}) };
}

type MachineEventSourceDefinition = Pick<PluginCheckpointedEventSourceDefinitionV1,
    'eventRef' | 'sourceContractVersion' | 'sourceConfig' | 'sourceInstanceId'>;

function decodeSource(definition: MachineEventSourceDefinition): Source | null {
    if (definition.eventRef.pluginId !== pluginId || definition.sourceContractVersion !== 1 || !isEventId(definition.eventRef.localId)) return null;
    const parsed = sourceSchema.safeParse(definition.sourceConfig);
    if (!parsed.success || !usesRetainedSummary(definition.eventRef.localId) && !parsed.data.machineId
        || descriptors[definition.eventRef.localId].scope === 'backup' && parsed.data.machineId !== undefined && !parsed.data.environmentId) return null;
    return parsed.data;
}

function matchesSource(fact: NonNullable<ReturnType<typeof projectFact>>, source: Source, event: string): boolean {
    return fact.serverId === source.serverId && (source.machineId === undefined || fact.machineId === source.machineId) && fact.event === event
        && (descriptors[fact.event].scope !== 'backup' || source.environmentId === undefined
            || 'environmentId' in fact && fact.environmentId === source.environmentId);
}

/** Finite publication consumes the same declaration-owned source matching as the observer. */
export function projectMachineServiceObservationForSource(payload: MachineServiceObservationV1,
    definition: MachineEventSourceDefinition, observedAt: number): PluginEventObservationV1 | null {
    const source = decodeSource(definition);
    const fact = projectFact(payload);
    if (!source || !fact || !matchesSource(fact, source, definition.eventRef.localId)) return null;
    const observation = projectMachineServiceObservation(payload, observedAt);
    return observation ? { ...observation, sourceInstanceId: definition.sourceInstanceId } : null;
}

type State = { source: Source; event: EventId; pending: PluginEventObservationV1[];
    latest: Map<string, { occurrenceId: string; occurredAt: number }> };
/** Observe already-decided live facts. The SDK runner owns admission and dedupe.
 * A checkpoint removes only the admitted prefix, preserving arrivals during admission. */
export function createMachineOutcomeEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'],
    now: () => number = Date.now, completionContext?: PluginInvocationContext): PluginCheckpointedEventSourceAdapterV1<Source, { state: State; count: number }> {
    const states = new Map<string, State>();
    const summaries = createMachineOutcomeSummaryReader(host);
    const enqueue = (state: State, payload: MachineServiceObservationV1, sourceInstanceId: string): boolean => {
        const fact = projectFact(payload);
        if (!fact || !matchesSource(fact, state.source, state.event)) return false;
        const observation = projectMachineServiceObservation(payload, now());
        if (!observation) return false;
        if (payload.kind === 'backup' || payload.kind === 'pressure') {
            const address = machineOutcomeSummaryAddress(payload);
            const key = address.key + ':' + address.slot;
            const previous = state.latest.get(key);
            if (previous && (previous.occurrenceId === observation.occurrenceId || previous.occurredAt > observation.occurredAt)) return false;
            state.latest.set(key, { occurrenceId: observation.occurrenceId, occurredAt: observation.occurredAt });
        }
        state.pending.push({ ...observation, sourceInstanceId });
        return true;
    };
    return {
        decode: decodeSource,
        async observe({ context, definition, source }) {
            let state = states.get(definition.sourceInstanceId);
            if (!state) {
                state = { source, event: definition.eventRef.localId as EventId, pending: [], latest: new Map() };
                states.set(definition.sourceInstanceId, state);
            }
            state.source = source;
            if (usesRetainedSummary(state.event)) for (const payload of await summaries.read(context, source.serverId, definition.sourceInstanceId)) {
                enqueue(state, payload, definition.sourceInstanceId);
            }
            return { observations: [...state.pending], checkpoint: { state, count: state.pending.length }, complete: true, nextEligibleAt: null };
        },
        async save({ checkpoint }) { checkpoint.state.pending.splice(0, checkpoint.count); },
        retryAt() { return null; },
        async retire({ definitions }) {
            const current = new Set(definitions.map(definition => definition.sourceInstanceId));
            for (const id of states.keys()) if (!current.has(id)) states.delete(id);
            summaries.retire(definitions);
            return { complete: true };
        },
        subscribeWake(wake) {
            const retained = summaries.subscribeWake(wake);
            const live = host.subscribe({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } }, async ({ payload }) => {
                const fact = projectFact(payload);
                if (!fact) return;
                const observation = projectMachineServiceObservation(payload, now());
                if (!observation) return;
                let completionError: unknown;
                try {
                    if (completionContext && 'completesActionIds' in descriptors[fact.event]) {
                        await admitNativeActionCompletionObservation(completionContext, observation);
                    }
                } catch (error) { completionError = error; }
                for (const [sourceInstanceId, state] of states) {
                    if (enqueue(state, payload, sourceInstanceId)) await wake(sourceInstanceId);
                }
                if (completionError !== undefined) throw completionError;
            });
            return { dispose() { live.dispose(); retained.dispose(); } };
        },
    };
}
export const machineOutcomeEventBackgroundServices = [{ declaration: {
    id: 'machine-outcome-observer', title: 'Backup and Machine pressure events', placement: 'daemon' as const,
}, async runner(context: BackgroundServiceContext) {
    await runCheckpointedPluginEventObserverV1({ context, source: createMachineOutcomeEventSourceAdapter(context.services.events.host, Date.now, context) });
} }];
