import { isDeepStrictEqual } from 'node:util';
import type { DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import type { HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { deploymentDomainProbeVantageV1, type DeploymentHealthObservationV1 } from '@happier-dev/deployments';
import type { DeploymentDomainHeaderV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import type { HealthCheckDefinitionV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DeploymentCurrentDomainObservationV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';

type Entry = Readonly<{ environmentId: string; targetLinkId: string; sourceInstanceId: string; checkId: string;
    caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
    domainId: string; domainRevision: number; observation: DeploymentHealthObservationV1 | null;
    domainObservation: DeploymentCurrentDomainObservationV1; tlsKind?: 'custom' | 'managed' }>;
type EdgeEntry = Entry & Readonly<{ observation: DeploymentHealthObservationV1 }>;
type Scope = Readonly<{ environmentId: string; targetLinkId: string; domainIds?: readonly string[] }>;
type Listener = Readonly<{ callback: () => void; scope?: Scope }>;
const statusRank = { up: 0, degraded: 1, unknown: 2, down: 3 } as const;

/** Runtime-only current facts from the incumbent saved-check observer, never its transition cursor. */
export function createCurrentDomainEdgeObservation() {
    const entries = new Map<string, Entry>();
    const listeners = new Set<Listener>();
    const key = (environmentId: string, targetLinkId: string, sourceInstanceId: string, checkId: string) =>
        JSON.stringify([environmentId, targetLinkId, sourceInstanceId, checkId]);
    const emit = (environmentId: string, targetLinkId: string, edgeChanged: boolean, domainIds: readonly string[]) => {
        if (!edgeChanged && !domainIds.length) return;
        for (const { callback, scope } of listeners) {
            if (!scope) { callback(); continue; }
            if (scope.environmentId !== environmentId || scope.targetLinkId !== targetLinkId) continue;
            const selectedDomains = scope.domainIds;
            if (selectedDomains ? domainIds.some(id => selectedDomains.includes(id)) : edgeChanged) callback();
        }
    };
    const isEdgeEntry = (entry: Entry): entry is EdgeEntry => entry.observation !== null;
    const readProof = (environmentId: string, targetLinkId: string): EdgeEntry | null => {
        let selected: EdgeEntry | null = null;
        for (const entry of entries.values()) {
            if (!isEdgeEntry(entry)) continue;
            const candidate = entry.observation;
            if (candidate.environmentId !== environmentId || candidate.targetLinkId !== targetLinkId) continue;
            if (!selected || statusRank[candidate.status] > statusRank[selected.observation.status]) selected = entry;
        }
        return selected;
    };
    const sameCurrent = (before: EdgeEntry | null, after: EdgeEntry | null) => {
        const a = before?.observation;
        const b = after?.observation;
        return a === b || a !== undefined && b !== undefined && a.status === b.status
            && a.machineId === b.machineId && a.targetLinkRevision === b.targetLinkRevision
            && a.source.kind === 'domain' && b.source.kind === 'domain'
            && a.source.observerMachineId === b.source.observerMachineId;
    };
    const sameDomain = (before: Entry | undefined, after: Entry) => {
        if (!before) return false;
        const semantic = (entry: Entry) => {
            const { observedAt: _observedAt, latencyMs: _latencyMs, ...result } = entry.domainObservation.result;
            return { ...entry.domainObservation, result, tlsKind: entry.tlsKind };
        };
        return isDeepStrictEqual(semantic(before), semantic(after));
    };
    const remove = (matches: (entry: Entry, identity: string) => boolean) => {
        const changed = new Map<string, { environmentId: string; targetLinkId: string;
            edge: EdgeEntry | null; domainIds: Set<string> }>();
        for (const [identity, entry] of entries) {
            if (!matches(entry, identity)) continue;
            const groupKey = JSON.stringify([entry.environmentId, entry.targetLinkId]);
            let group = changed.get(groupKey);
            if (!group) {
                group = { environmentId: entry.environmentId, targetLinkId: entry.targetLinkId,
                    edge: readProof(entry.environmentId, entry.targetLinkId), domainIds: new Set() };
                changed.set(groupKey, group);
            }
            group.domainIds.add(entry.domainId);
            entries.delete(identity);
        }
        for (const group of changed.values()) emit(group.environmentId, group.targetLinkId,
            !sameCurrent(group.edge, readProof(group.environmentId, group.targetLinkId)), [...group.domainIds]);
    };
    return Object.freeze({
        publish(input: Readonly<{ sourceInstanceId: string; sourceRevision: string; checkId: string; kind: 'http' | 'certificate';
            caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
            environment: DeploymentEnvironmentHeaderV1; targetLink: DeploymentTargetLinkHeaderV1;
            domain: DeploymentDomainHeaderV1; observer: Readonly<{ machineId: string }>;
            result: HealthCheckResultV1; tlsKind?: 'custom' | 'managed' }>) {
            const environment = input.environment;
            const identity = key(environment.id, input.targetLink.id, input.sourceInstanceId, input.checkId);
            const before = readProof(environment.id, input.targetLink.id);
            const edgeMachineId = environment.ingress?.kind === 'edgeCaddy' ? environment.ingress.edgeMachineId : null;
            const valid = environment.controllerMachineId === input.observer.machineId
                && environment.runtimeTargetLinkId === input.targetLink.id
                && input.domain.targetLinkId === input.targetLink.id;
            if (!valid) {
                remove((_entry, candidate) => candidate === identity);
                return;
            }
            const vantage = deploymentDomainProbeVantageV1(environment, input.targetLink, input.observer.machineId);
            const observation: DeploymentHealthObservationV1 | null = input.kind === 'http'
                && vantage === 'outside' && edgeMachineId ? {
                environmentId: environment.id, targetLinkId: input.targetLink.id,
                targetLinkRevision: input.targetLink.revision, machineId: edgeMachineId,
                role: 'edge', source: { kind: 'domain', observerMachineId: input.observer.machineId },
                status: input.result.status, observedAtMs: input.result.observedAt,
                ...(input.result.latencyMs === undefined ? {} : { latencyMs: input.result.latencyMs }),
            } : null;
            const next: Entry = { environmentId: environment.id, targetLinkId: input.targetLink.id,
                sourceInstanceId: input.sourceInstanceId, checkId: input.checkId,
                caller: input.caller, occurrenceId: input.occurrenceId, check: input.check,
                domainId: input.domain.id,
                domainRevision: input.domain.revision, observation,
                domainObservation: { domainId: input.domain.id, domainRevision: input.domain.revision,
                    targetLinkRevision: input.targetLink.revision, kind: input.kind,
                    observerMachineId: input.observer.machineId, vantage, result: input.result },
                ...(input.tlsKind === undefined ? {} : { tlsKind: input.tlsKind }) };
            const domainChanged = !sameDomain(entries.get(identity), next);
            entries.set(identity, next);
            emit(environment.id, input.targetLink.id, !sameCurrent(before, readProof(environment.id, input.targetLink.id)),
                domainChanged ? [input.domain.id] : []);
        },
        readProof,
        readDomainProofs(environmentId: string, targetLinkId: string, domainIds?: readonly string[],
            source?: Readonly<{ sourceInstanceId: string; observerMachineId: string; checks: readonly HealthCheckDefinitionV1[] }>): readonly Entry[] {
            return [...entries.values()].filter(entry => entry.environmentId === environmentId
                && entry.targetLinkId === targetLinkId && (!domainIds || domainIds.includes(entry.domainId))
                && (!source || entry.sourceInstanceId === source.sourceInstanceId
                    && entry.domainObservation.observerMachineId === source.observerMachineId
                    && source.checks.some(check => check.checkId === entry.checkId && isDeepStrictEqual(check, entry.check))));
        },
        read(environmentId: string, targetLinkId: string): DeploymentHealthObservationV1 | null {
            return readProof(environmentId, targetLinkId)?.observation ?? null;
        },
        withdraw(environmentId: string, targetLinkId?: string) {
            remove(entry => entry.environmentId === environmentId && (!targetLinkId || entry.targetLinkId === targetLinkId));
        },
        withdrawDomain(environmentId: string, domainId: string) {
            remove(entry => entry.environmentId === environmentId && entry.domainId === domainId);
        },
        reconcile(isCurrent: (entry: Entry) => boolean) {
            remove(entry => !isCurrent(entry));
        },
        subscribe(callback: () => void, scope?: Scope) {
            const listener = { callback, scope };
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
        dispose() { remove(() => true); listeners.clear(); },
    });
}

export type CurrentDomainEdgeObservation = ReturnType<typeof createCurrentDomainEdgeObservation>;
