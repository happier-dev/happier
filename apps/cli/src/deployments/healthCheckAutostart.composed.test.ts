import { afterEach, expect, it, vi } from 'vitest';
import { MachineServiceRowV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { AutomationEventSourceDefinitionV1Schema, AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createConfiguredHealthCheckNotices } from './deploymentServiceHealthNotices';

afterEach(() => vi.restoreAllMocks());

it.each([
    { kind: 'throw', admitted: true, outcome: null, visible: 'may have started' },
    { kind: 'selection', admitted: true, outcome: { v: 1, handoff: { kind: 'placement_choice_required', reason: 'ambiguous_workspace', candidates: [], agents: [] } }, visible: 'Choose' },
    { kind: 'approval', admitted: true, outcome: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'investigate' }, visible: 'needs approval' },
    { kind: 'refusal', admitted: true, outcome: { ok: false, errorCode: 'permission_denied', effectAttempted: false }, visible: 'access was denied' },
    { kind: 'not admitted', admitted: false, outcome: null, visible: 'failed' },
    { kind: 'inbox', admitted: true, outcome: null, visible: 'failed' },
    { kind: 'default', admitted: true, outcome: null, visible: 'failed' },
])('starts Triage only for an admitted opening and keeps $kind on the same notice', async ({ kind, admitted, outcome, visible }) => {
    const f = createPlainAccountArtifactHttpBoundary();
    const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
    const subject = { kind: 'machineService' as const, machineId: 'subject-machine', serviceId: 'nginx' };
    const definition = AutomationEventSourceDefinitionV1Schema.parse({ observationOnly: { kind: 'observationOnly' },
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'health', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1,
        filter: null, maximumObservationAgeMs: null, eventRef: { pluginId: caller.pluginId, localId: 'health-status' },
        sourceConfig: { v: 1, subject, ...(kind === 'default' ? {} : { investigation: kind === 'inbox'
            ? { mode: 'inbox' } : { mode: 'auto_start', configuredActionId: 'investigate' } }),
            checks: [{ checkId: 'tcp', kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
                config: { host: 'private-host', port: 80 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] },
        sourceInstanceId: 'saved-health', observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller } });
    const service = MachineServiceRowV1Schema.parse({ serviceId: subject.serviceId, name: 'Web server', authority: 'machine',
        lifecyclePurpose: 'infrastructure', generation: null, state: 'running', watchId: 'watch', watchRevision: '1',
        capabilities: { start: false, stop: false, restart: false, logs: true, accounting: false } });
    const calls: unknown[] = [];
    const host = { credentials: f.credentials, serverId: 'home', serverHttpBaseUrl: 'https://health-notices.test', machineId: caller.machineId,
        readService: async () => service, readEnvironment: async () => { throw new Error('Unexpected Environment read'); },
        executeAction: async (ref: Readonly<{ localId: string }>, input: unknown) => {
            calls.push({ ref, input });
            if (ref.localId === 'actions/read-v1') return { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{
                label: 'Investigate', selection: { configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
                    agentChoice: { kind: 'configured' }, delivery: 'configured' } }] };
            if (kind === 'throw') throw new Error('PRIVATE_RECOVERY_PAYLOAD');
            return outcome;
        } };
    const consume = (transition: 'failed' | 'recovered', time: number) => createConfiguredHealthCheckNotices(host)({
        caller, definition, admitted, signal: new AbortController().signal,
        observation: AutomationEventAdmitInputV1Schema.parse({ eventRef: definition.eventRef, occurrenceId: `${transition}-${time}`,
            occurredAt: time, observationReceivedAt: time, definitions: [{ automationId: definition.automationId,
                triggerId: definition.triggerId, triggerRevision: definition.triggerRevision, sourceSelectorId: definition.sourceSelectorId }],
            payload: { sourceInstanceId: definition.sourceInstanceId, subject, checkId: 'tcp', transition, observedAt: time } }) });
    expect(await consume('failed', 100)).toMatchObject({ kind: 'consumed', changed: true });
    const starts = admitted && kind !== 'inbox' && kind !== 'default';
    expect(calls).toHaveLength(starts ? 2 : 0);
    if (starts) expect(calls[1]).toMatchObject({ input: { handoff: { task: 'investigate', delivery: 'send',
        context: { kind: 'healthAlert', target: { machine: { machineId: subject.machineId } } },
        evidence: [{ kind: 'alert', notice: { artifactId: [...f.rows.keys()][0] } }] } } });
    expect(f.rows.size).toBe(1);
    const body = decodePlainArtifactStoredContent(String([...f.rows.values()][0]!.body));
    expect(JSON.stringify(body)).toContain(visible);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_RECOVERY_PAYLOAD');
    await consume('failed', 200);
    await consume('recovered', 300);
    expect(calls).toHaveLength(starts ? 2 : 0);
});
