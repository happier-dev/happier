import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentHealthAggregateLeaseV1 } from '@happier-dev/deployments';
import type { StoredCredentials } from '@/persistence';
import type { ProjectManagedServiceHandle, EnvironmentProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { MachineDeploymentServiceIdentityV1Schema } from '@happier-dev/protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';
import { createCommittedServiceHealthDelivery } from '@/notifications/activity/committedServiceHealthDelivery';
import { observeNativeWorkload } from './healthChecks/readNativeWorkload';
import type { createMachineServiceRowProjection } from '@/daemon/local/services/launch/machineServiceRowProjection';
import type { CurrentDomainEdgeObservation } from './healthChecks/currentDomainEdgeObservation';

export type DeploymentServiceHealthNoticeInput = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    homeServerIdentityId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    environment: DeploymentEnvironmentDetailV1;
    readEnvironment(signal: AbortSignal): Promise<DeploymentEnvironmentDetailV1>;
    handles: readonly Extract<ProjectManagedServiceHandle, { kind: 'environment' }>[];
    health?: DeploymentHealthAggregateLeaseV1;
    nativeWorkload?: Readonly<{
        installationId: string;
        handles: readonly EnvironmentProjectManagedServiceHandle[];
        rows: Pick<ReturnType<typeof createMachineServiceRowProjection>, 'read' | 'subscribe'>;
        edge?: CurrentDomainEdgeObservation;
        receipts(environment: DeploymentEnvironmentDetailV1, signal: AbortSignal): AsyncIterable<DeploymentReceiptDetailV1>;
    }>;
}>;

/** Connects the admitted deployment observations to the canonical C1 owner. */
export function attachDeploymentServiceHealthNotices(input: DeploymentServiceHealthNoticeInput): Readonly<{
    dispose(): void;
    settled(): Promise<void>;
}> {
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!accountId) throw Object.assign(new Error('notice_account_scope_mismatch'), { code: 'notice_account_scope_mismatch' });
    const services = input.handles.map(handle => {
        const subject = MachineDeploymentServiceIdentityV1Schema.parse(handle.identity);
        if (subject.machineId !== input.machineId || subject.environmentId !== input.environment.environment.id
            || handle.serverId !== input.homeServerIdentityId) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
        return { handle, subject };
    });
    const controller = new AbortController();
    const store = createCredentialedAccountArtifactStore(input.credentials);
    const deliver = createCommittedServiceHealthDelivery(input);
    const cleanups: Array<() => void> = [];
    let admittedEnvironment: DeploymentEnvironmentDetailV1 | null = null;
    // Source access is admitted once for this attachment. The service runs on
    // this Account's Machine; redeploy/teardown owns the next admission boundary.
    let health = input.health;
    const currentHealth = () => !controller.signal.aborted && health?.isCurrent() === true;
    let pending = services.length === 0 && !currentHealth() && !input.nativeWorkload ? Promise.resolve() : input.readEnvironment(controller.signal).then(async fresh => {
        const environment = fresh.environment;
        if (!controller.signal.aborted && environment.id === input.environment.environment.id
            && environment.serverId === input.serverId
            && environment.projectSourceId === input.environment.environment.projectSourceId
            && environment.capabilities.read && fresh.targetLinks.some(({ targetLink }) =>
                targetLink.id === environment.runtimeTargetLinkId && targetLink.members.some(member =>
                    member.machineId === input.machineId && member.state === 'active'))) admittedEnvironment = fresh;
        const native = input.nativeWorkload;
        if (!admittedEnvironment || !native || environment.controllerMachineId !== input.machineId) return;
        const owned = await observeNativeWorkload({ environment: fresh,
            receipts: native.receipts(fresh, controller.signal), signal: controller.signal, observedAtMs: Date.now(),
            ...(native.edge ? { edge: native.edge } : {}),
            local: { machineId: input.machineId, installationId: native.installationId,
                rows: native.rows,
                resolve: identity => native.handles.find(handle => handle.serverId === input.homeServerIdentityId
                    && handle.identity.composeService === identity.composeService && handle.identity.environmentId === identity.environmentId
                    && handle.identity.machineId === identity.machineId) ?? null },
        });
        if (!owned) return;
        health = owned;
        cleanups.push(() => owned.dispose());
        attachHealth(owned, accountId);
    });
    void pending.catch(error => {
        if (!controller.signal.aborted) logger.infoFile('[deploymentHealth] Notice admission failed', {
            errorCode: error instanceof Error && 'code' in error ? error.code : 'notice_write_failed',
        });
    });
    function attachHealth(health: DeploymentHealthAggregateLeaseV1, accountId: string) {
        if (!currentHealth()) return;
        const signal = AbortSignal.any([controller.signal, health.retirementSignal]);
        const observation = health.observe(aggregate => {
            const recovered = aggregate.authoritativeRecovery;
            const expectedStop = aggregate.expectedDown === 'stop' && aggregate.down === 0 && aggregate.degraded === 0;
            // Unknown cannot recover an earlier outage. Expected native Stop
            // retains actual down evidence without an actionable outage count.
            if (!currentHealth() || !recovered && !expectedStop && aggregate.down === 0 && aggregate.degraded === 0) return;
            pending = pending.catch(() => {}).then(async () => {
                if (!currentHealth()) return;
                const fresh = admittedEnvironment;
                if (!fresh || aggregate.environmentId !== fresh.environment.id
                    || aggregate.targetLinkId !== fresh.environment.runtimeTargetLinkId) return;
                const committed = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => store.writeNotice({
                    accountId, source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                        environmentId: aggregate.environmentId, targetLinkId: aggregate.targetLinkId, condition: 'health' } },
                    page: { kind: 'host', page: 'environment', targetLinkId: aggregate.targetLinkId,
                        environment: { serverId: input.serverId, projectSourceId: fresh.environment.projectSourceId,
                            environmentId: aggregate.environmentId } },
                    title: expectedStop ? 'Environment expected during stop' : recovered ? 'Environment recovered' : `${aggregate.down} of ${aggregate.n} servers down`,
                    type: !recovered && !expectedStop && aggregate.protection === 'production' ? 'blocked' : 'update',
                    healthPhase: recovered ? 'recovered' : 'open', resolved: false,
                    environmentHealth: aggregate,
                    body: aggregate.members.flatMap(member => member.evidence.filter(evidence => evidence.status !== 'up')
                        .map(evidence => `${member.machineId} ${evidence.role}: ${evidence.status}${evidence.reason ? ` (${evidence.reason})` : ''}.`)).join(' '),
                    signal,
                }));
                if (!committed.changed || !committed.healthOpening || !currentHealth()) return;
                const current = health.snapshot();
                if (current.down === 0 && current.degraded === 0) return;
                await deliver({ receipt: committed, signal, controllerMachineId: fresh.environment.controllerMachineId });
            });
            void pending.catch(error => {
                if (!signal.aborted) logger.infoFile('[deploymentHealth] Aggregate notice write failed', {
                    errorCode: error instanceof Error && 'code' in error ? error.code : 'notice_write_failed',
                });
            });
        });
        const retire = () => observation.dispose();
        health.retirementSignal.addEventListener('abort', retire, { once: true });
        cleanups.push(() => { observation.dispose(); health.retirementSignal.removeEventListener('abort', retire); });
    }
    if (health) attachHealth(health, accountId);
    for (const { handle, subject } of services) {
        const signal = AbortSignal.any([controller.signal, handle.retirementSignal]);
        const isCurrent = () => !signal.aborted && handle.isCurrent();
        const observation = handle.observeHealth(snapshot => {
            // The service owner alone classifies health. Unknown/retired is
            // neither an outage nor evidence that an earlier outage recovered.
            if (!isCurrent() || !['healthy', 'unhealthy', 'failed', 'stopped'].includes(snapshot.state)) return;
            pending = pending.catch(() => {}).then(async () => {
                if (!isCurrent()) return;
                const fresh = admittedEnvironment;
                if (!fresh) return;
                const expectedStop = snapshot.expectedDown === 'stop';
                const recovered = snapshot.state === 'healthy' && !expectedStop;
                const committed = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => store.writeNotice({
                    accountId, source: { kind: 'host', topic: 'service_health', subject },
                    page: { kind: 'host', page: 'machine_service', service: subject,
                        machine: { serverId: input.serverId, machineId: subject.machineId },
                        environment: { serverId: input.serverId, projectSourceId: fresh.environment.projectSourceId,
                            environmentId: subject.environmentId } },
                    title: `${subject.composeService} ${expectedStop ? 'expected during stop' : recovered ? 'recovered' : 'needs attention'}`,
                    type: !recovered && !expectedStop && fresh.environment.protection === 'production' ? 'blocked' : 'update',
                    healthPhase: recovered ? 'recovered' : 'open', resolved: false,
                    body: [`Service health: ${snapshot.state}.`,
                        ...(snapshot.readiness ? [`Readiness: ${snapshot.readiness.replaceAll('_', ' ')}.`] : []),
                        ...(snapshot.nativePhase ? [`Native phase: ${snapshot.nativePhase.replaceAll('_', ' ')}.`] : []),
                    ].join(' '),
                    signal,
                }));
                if (!committed.changed || !committed.healthOpening) return;
                // Read the service owner's cached fact, never run another probe.
                const openingCurrent = () => isCurrent() && ['unhealthy', 'failed', 'stopped'].includes(handle.snapshot().state);
                if (!openingCurrent()) return;
                await deliver({ receipt: committed, signal, controllerMachineId: fresh.environment.controllerMachineId });
            });
            // Keep failures observable without an unhandled background rejection.
            // A later genuine owner transition can progress; there is no retry timer.
            void pending.catch(error => {
                if (!signal.aborted) logger.infoFile('[deploymentHealth] Notice write failed', {
                    errorCode: error instanceof Error && 'code' in error ? error.code : 'notice_write_failed',
                });
            });
        });
        const retire = () => observation.dispose();
        handle.retirementSignal.addEventListener('abort', retire, { once: true });
        cleanups.push(() => { observation.dispose(); handle.retirementSignal.removeEventListener('abort', retire); });
    }
    return {
        dispose() { controller.abort(); for (const cleanup of cleanups) cleanup(); },
        async settled() {
            let tail: Promise<void>;
            do { tail = pending; await tail; } while (tail !== pending);
        },
    };
}
