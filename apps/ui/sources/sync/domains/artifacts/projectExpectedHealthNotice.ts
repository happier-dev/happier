import type { ActionOperationProjection } from '../actionOperations/actionOperationSelectors';
import type { ServerAccountScope } from '../scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '../server/serverProfiles';
import type { AccountNoticeArtifact, ExpectedHealthOperation } from './usageNoticeArtifacts';

/** Presentation of the same C1 condition, from already-readable Action facts.
 * No guessed operation id, service name, presence bit or server-side expectation. */
export function projectExpectedHealthNotice(entry: AccountNoticeArtifact, operations: readonly ActionOperationProjection[],
    scope: ServerAccountScope | null): AccountNoticeArtifact {
    const { header } = entry;
    if (!scope || header.source.kind !== 'host' || header.source.topic !== 'service_health'
        || header.healthPhase !== 'open' || header.resolved) return entry;
    const subject = header.source.subject;
    let selected: Readonly<{ kind: ExpectedHealthOperation['kind']; operation: ActionOperationProjection }> | undefined;
    for (const operation of operations) {
        const snapshot = operation.snapshot, ref = snapshot.domainRef;
        if (snapshot.state !== 'running' || snapshot.observation || operation.isUnavailableProjection
            || operation.observation === 'unavailable' || snapshot.scope.accountId !== scope.accountId
            || !areServerProfileIdentifiersEquivalent(operation.serverId, scope.serverId)
            || !ref || !('serverId' in ref) || !areServerProfileIdentifiersEquivalent(ref.serverId, scope.serverId)) continue;
        let kind: ExpectedHealthOperation['kind'] | undefined;
        if (ref.kind === 'machineService' && ref.subject.kind === 'machineService' && ref.operation !== 'start'
            && ref.subject.machineId === snapshot.scope.machineId) {
            const service = subject.kind === 'healthCheck' && subject.subject.kind === 'machineService' ? subject.subject
                : subject.kind === 'deployment' || subject.kind === 'adopted' ? subject : null;
            if (service?.machineId === ref.subject.machineId && service.serviceId === ref.subject.serviceId) kind = ref.operation;
        } else if (ref.kind === 'deployment') {
            const environmentId = subject.kind === 'deployment' || subject.kind === 'environment' && subject.condition === 'health'
                ? subject.environmentId : subject.kind === 'healthCheck' && subject.subject.kind === 'environment'
                    ? subject.subject.environmentId : null;
            if (environmentId === ref.environmentId) kind = 'deploy';
        } else if (ref.kind === 'machineReboot' && ref.basis?.dispatchStarted && ref.machineId === snapshot.scope.machineId) {
            const service = subject.kind === 'healthCheck' && subject.subject.kind === 'machineService' ? subject.subject
                : subject.kind === 'deployment' || subject.kind === 'adopted' ? subject : null;
            if (service?.machineId === ref.machineId && ref.basis.expectedRunningServicesKnown
                && ref.basis.expectedRunningServiceIds.includes(service.serviceId)) kind = 'reboot';
            if (subject.kind === 'domain' && subject.condition === 'domain_probe_failed'
                && ref.basis.domains?.some(domain => domain.environmentId === subject.environmentId
                    && domain.targetLinkId === subject.targetLinkId && domain.domainId === subject.domainId
                    && domain.machineId === ref.machineId && domain.installationId === ref.installationId)) kind = 'reboot';
        }
        if (kind && (!selected || snapshot.createdAt > selected.operation.snapshot.createdAt)) selected = { kind, operation };
    }
    if (!selected) return entry;
    const operation = { serverId: selected.operation.serverId, machineId: selected.operation.snapshot.scope.machineId,
        operationId: selected.operation.snapshot.operationId };
    return { ...entry, header: header.type === 'update' ? header : { ...header, type: 'update' },
        expectedDuring: { kind: selected.kind, operation } };
}
