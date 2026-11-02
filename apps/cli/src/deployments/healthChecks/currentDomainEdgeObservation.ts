import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import type { HealthCheckResultV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentHealthObservationV1 } from '@happier-dev/deployments';
import type { DeploymentDomainHeaderV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import type { HealthCheckDefinitionV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

type Entry = Readonly<{ sourceInstanceId: string; checkId: string;
    caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
    domainId: string; domainRevision: number; observation: DeploymentHealthObservationV1 }>;
type Listener = () => void;
const statusRank = { up: 0, degraded: 1, unknown: 2, down: 3 } as const;

/** Runtime-only current facts from the incumbent saved-check observer, never its transition cursor. */
export function createCurrentDomainEdgeObservation() {
    const entries = new Map<string, Entry>();
    const listeners = new Set<Listener>();
    const key = (environmentId: string, targetLinkId: string, sourceInstanceId: string, checkId: string) =>
        JSON.stringify([environmentId, targetLinkId, sourceInstanceId, checkId]);
    const emit = () => { for (const listener of listeners) listener(); };
    const readProof = (environmentId: string, targetLinkId: string): Entry | null => {
        let selected: Entry | null = null;
        for (const entry of entries.values()) {
            const candidate = entry.observation;
            if (candidate.environmentId !== environmentId || candidate.targetLinkId !== targetLinkId) continue;
            if (!selected || statusRank[candidate.status] > statusRank[selected.observation.status]) selected = entry;
        }
        return selected;
    };
    const sameCurrent = (before: Entry | null, after: Entry | null) => {
        const a = before?.observation;
        const b = after?.observation;
        return a === b || a !== undefined && b !== undefined && a.status === b.status
            && a.machineId === b.machineId && a.targetLinkRevision === b.targetLinkRevision
            && a.source.kind === 'domain' && b.source.kind === 'domain'
            && a.source.observerMachineId === b.source.observerMachineId;
    };
    const emitIfChanged = (before: Entry | null, environmentId: string, targetLinkId: string) => {
        if (!sameCurrent(before, readProof(environmentId, targetLinkId))) emit();
    };
    return Object.freeze({
        publish(input: Readonly<{ sourceInstanceId: string; sourceRevision: string; checkId: string; kind: 'http' | 'certificate';
            caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
            environment: DeploymentEnvironmentHeaderV1; targetLink: DeploymentTargetLinkHeaderV1;
            domain: DeploymentDomainHeaderV1; observer: Readonly<{ machineId: string }>;
            result: HealthCheckResultV1 }>) {
            if (input.kind !== 'http') return;
            const environment = input.environment;
            const identity = key(environment.id, input.targetLink.id, input.sourceInstanceId, input.checkId);
            const before = readProof(environment.id, input.targetLink.id);
            const edgeMachineId = environment.ingress?.kind === 'edgeCaddy' ? environment.ingress.edgeMachineId : null;
            const valid = edgeMachineId && edgeMachineId !== input.observer.machineId
                && environment.controllerMachineId === input.observer.machineId
                && environment.runtimeTargetLinkId === input.targetLink.id
                && input.domain.targetLinkId === input.targetLink.id;
            if (!valid) {
                if (entries.delete(identity)) emitIfChanged(before, environment.id, input.targetLink.id);
                return;
            }
            const observation: DeploymentHealthObservationV1 = {
                environmentId: environment.id, targetLinkId: input.targetLink.id,
                targetLinkRevision: input.targetLink.revision, machineId: edgeMachineId,
                role: 'edge', source: { kind: 'domain', observerMachineId: input.observer.machineId },
                status: input.result.status, observedAtMs: input.result.observedAt,
                ...(input.result.latencyMs === undefined ? {} : { latencyMs: input.result.latencyMs }),
            };
            const next = { sourceInstanceId: input.sourceInstanceId, checkId: input.checkId,
                caller: input.caller, occurrenceId: input.occurrenceId, check: input.check,
                domainId: input.domain.id,
                domainRevision: input.domain.revision, observation };
            entries.set(identity, next);
            emitIfChanged(before, environment.id, input.targetLink.id);
        },
        readProof,
        read(environmentId: string, targetLinkId: string): DeploymentHealthObservationV1 | null {
            return readProof(environmentId, targetLinkId)?.observation ?? null;
        },
        withdraw(environmentId: string, targetLinkId?: string) {
            const before = new Map<string, Entry | null>();
            for (const [identity, entry] of entries) {
                if (entry.observation.environmentId !== environmentId
                    || targetLinkId && entry.observation.targetLinkId !== targetLinkId) continue;
                before.set(entry.observation.targetLinkId,
                    before.get(entry.observation.targetLinkId) ?? readProof(environmentId, entry.observation.targetLinkId));
                entries.delete(identity);
            }
            for (const [linkId, prior] of before) emitIfChanged(prior, environmentId, linkId);
        },
        withdrawDomain(environmentId: string, domainId: string) {
            const before = new Map<string, Entry | null>();
            for (const [identity, entry] of entries) {
                if (entry.observation.environmentId !== environmentId || entry.domainId !== domainId) continue;
                before.set(entry.observation.targetLinkId,
                    before.get(entry.observation.targetLinkId) ?? readProof(environmentId, entry.observation.targetLinkId));
                entries.delete(identity);
            }
            for (const [linkId, prior] of before) emitIfChanged(prior, environmentId, linkId);
        },
        reconcile(isCurrent: (entry: Entry) => boolean) {
            const before = new Map<string, Entry | null>();
            for (const [identity, entry] of entries) {
                if (isCurrent(entry)) continue;
                const key = JSON.stringify([entry.observation.environmentId, entry.observation.targetLinkId]);
                before.set(key, before.get(key) ?? readProof(entry.observation.environmentId, entry.observation.targetLinkId));
                entries.delete(identity);
            }
            for (const [key, prior] of before) {
                const [environmentId, targetLinkId] = JSON.parse(key) as [string, string];
                emitIfChanged(prior, environmentId, targetLinkId);
            }
        },
        subscribe(listener: Listener) {
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
        dispose() { if (entries.size) { entries.clear(); emit(); } listeners.clear(); },
    });
}

export type CurrentDomainEdgeObservation = ReturnType<typeof createCurrentDomainEdgeObservation>;
