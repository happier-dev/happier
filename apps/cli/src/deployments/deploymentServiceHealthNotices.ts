import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentHealthAggregateLeaseV1 } from '@happier-dev/deployments';
import type { StoredCredentials } from '@/persistence';
import type { ProjectManagedServiceHandle, EnvironmentProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { MachineDeploymentServiceIdentityV1Schema } from '@happier-dev/protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';
import { deploymentNoticeRollbackChoice, readDeploymentNoticeHistory } from './deploymentNoticeRecovery';
import { readDeploymentNoticeMachineLabels } from './deploymentNoticeLabels';
import type { AccountNoticeRecoveryChoiceV1 } from '@happier-dev/protocol/activity/accountNoticeRecoveryV1';
import { createCommittedServiceHealthDelivery } from '@/notifications/activity/committedServiceHealthDelivery';
import { observeNativeWorkload } from './healthChecks/readNativeWorkload';
import { projectSavedHealthAlertSelection, type SavedHealthCheckSourceRead } from './healthChecks/readSavedHealthCheckSource';
import type { createMachineServiceRowProjection } from '@/daemon/local/services/launch/machineServiceRowProjection';
import type { CurrentDomainEdgeObservation } from './healthChecks/currentDomainEdgeObservation';
import type { CommittedAutomationEventObservationV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';
import type { MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { HealthCheckSourceConfigV1Schema, HealthCheckTransitionV1Schema, createHealthCheckSourceInstanceIdV1,
    type ServiceHealthNoticePageV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readTriageAutomaticInvestigationChoiceV1, requestTriageAutomaticInvestigationV1,
    type TriageSessionHandoffHostV1 } from '@happier-dev/triage-sources/runtime';

export type ConfiguredHealthCheckNoticeHost = Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    readService(subject: Readonly<{ machineId: string; serviceId: string }>, signal: AbortSignal): Promise<MachineServiceRowV1 | null>;
    readEnvironment(environmentId: string, signal: AbortSignal): Promise<Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>>;
    executeAction?: TriageSessionHandoffHostV1['executeAction'];
}>;

/** The observer settled thresholds and E2 stamped this occurrence's admission.
 * C1 alone decides equal updates, private retention and notification opening. */
export function createConfiguredHealthCheckNotices(host: ConfiguredHealthCheckNoticeHost) {
    const store = createCredentialedAccountArtifactStore(host.credentials);
    const deliver = createCommittedServiceHealthDelivery(host);
    const unavailable = (): never => { throw createActionExecuteFailureError({ ok: false, errorCode: 'health_check_subject_unavailable', error: 'health_check_subject_unavailable' }); };
    return async (input: CommittedAutomationEventObservationV1) => {
        const source = HealthCheckSourceConfigV1Schema.safeParse(input.definition.sourceConfig);
        if (!source.success) return { kind: 'notApplicable' as const };
        const transition = HealthCheckTransitionV1Schema.parse(input.observation.payload);
        const check = source.data.checks.find(check => check.checkId === transition.checkId);
        if (!check || check.binding.kind === 'environmentHealth') return { kind: 'notApplicable' as const };
        if (input.definition.sourceInstanceId !== transition.sourceInstanceId
            || !sameStrictJsonValue(source.data.subject, transition.subject)) return unavailable();
        input.signal.throwIfAborted();
        const accountId = readAccountIdFromToken(host.credentials.token);
        if (!accountId) throw createActionExecuteFailureError({ ok: false, errorCode: 'notice_account_scope_mismatch', error: 'notice_account_scope_mismatch' });
        let page: ServiceHealthNoticePageV1;
        let protection: DeploymentEnvironmentDetailV1['environment']['protection'] = 'nonProduction';
        let controllerMachineId: string | null | undefined = host.machineId;
        let name: string;
        const subject = source.data.subject;
        if (subject.kind === 'environment') {
            const detail = await host.readEnvironment(subject.environmentId, input.signal);
            if (detail.environment.id !== subject.environmentId || !detail.environment.capabilities.read) return unavailable();
            page = { kind: 'host', page: 'environment', targetLinkId: check.binding.kind === 'domain'
                ? check.binding.targetLinkId : detail.environment.runtimeTargetLinkId,
                environment: { serverId: host.serverId, projectSourceId: detail.environment.projectSourceId,
                    environmentId: subject.environmentId } };
            protection = detail.environment.protection;
            controllerMachineId = detail.environment.controllerMachineId;
            name = detail.content.name;
        } else {
            const service = await host.readService(subject, input.signal);
            if (!service || service.serviceId !== subject.serviceId || service.unavailableReason) return unavailable();
            const identity = service.deployment?.service ?? (service.authority === 'machine' && service.watchId && service.watchRevision
                ? { kind: 'adopted' as const, machineId: subject.machineId, serviceId: subject.serviceId,
                    watchId: service.watchId, watchRevision: service.watchRevision } : null);
            if (!identity) return unavailable();
            page = { kind: 'host', page: 'machine_service', machine: { serverId: host.serverId, machineId: subject.machineId },
                service: identity };
            name = service.name;
            if (identity.kind === 'deployment') {
                const detail = await host.readEnvironment(identity.environmentId, input.signal);
                page = { ...page, environment: { serverId: host.serverId, projectSourceId: detail.environment.projectSourceId,
                    environmentId: identity.environmentId } };
                protection = detail.environment.protection;
                controllerMachineId = detail.environment.controllerMachineId;
            }
        }
        input.signal.throwIfAborted();
        const recovered = transition.transition === 'recovered';
        const notice = {
            accountId, source: { kind: 'host', topic: 'service_health', subject: check.binding.kind === 'domain'
                && subject.kind === 'environment'
                ? { kind: 'domain', environmentId: subject.environmentId, targetLinkId: check.binding.targetLinkId,
                    domainId: check.binding.domainId, condition: check.binding.condition }
                : { kind: 'healthCheck', subject, checkId: check.checkId } }, page,
            title: `${name}: ${check.checkId} ${recovered ? 'recovered' : 'needs attention'}`,
            type: !recovered && protection === 'production' ? 'blocked' : 'update',
            healthPhase: recovered ? 'recovered' : 'open', resolved: false,
            body: `Saved health check ${recovered ? 'recovered' : 'failed'}.`, signal: input.signal,
        } satisfies Parameters<typeof store.writeNotice>[0];
        const committed = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice(notice));
        try { await deliver({ receipt: committed, signal: input.signal, controllerMachineId, alerts: source.data.alerts }); }
        catch (error) {
            if (!input.signal.aborted) logger.warnLocalFile('[deploymentHealth] Check notice delivery unavailable', {
                failureCause: projectActionFailureCauseV1(error, 'deployment.notice.check_delivery', { allowUnknownErrorCode: false }),
            });
        }
        if (committed.opened === true && source.data.investigation?.mode === 'auto_start') {
            const triage: TriageSessionHandoffHostV1 = { executeAction: host.executeAction ?? (async () => ({
                ok: false, errorCode: 'target_unavailable', effectAttempted: false,
            })) };
            const selection = await readTriageAutomaticInvestigationChoiceV1(triage,
                source.data.investigation.configuredActionId, { signal: input.signal });
            const reference = { kind: 'host' as const, artifactId: committed.artifactId, source: notice.source };
            const outcome = typeof selection === 'string' ? selection : await requestTriageAutomaticInvestigationV1(triage, {
                selection, context: { kind: 'healthAlert', notice: reference, target: page },
                evidence: [{ kind: 'alert', notice: reference }],
            }, { signal: input.signal });
            if (outcome !== null) {
                try {
                    await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.writeNotice({ ...notice,
                        body: `${notice.body}\n${outcome}` }));
                } catch (error) {
                    if (!input.signal.aborted) logger.warnLocalFile('[deploymentHealth] Investigation notice update unavailable', {
                        failureCause: projectActionFailureCauseV1(error, 'deployment.notice.investigation_update', { allowUnknownErrorCode: false }),
                    });
                }
            }
        }
        return { kind: 'consumed' as const, changed: committed.changed, artifactId: committed.artifactId };
    };
}

export type DeploymentServiceHealthNoticeInput = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    homeServerIdentityId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    environment: Pick<DeploymentEnvironmentDetailV1, 'environment'>;
    recoveryReceipt?: DeploymentReceiptDetailV1;
    serviceRows?: Pick<ReturnType<typeof createMachineServiceRowProjection>, 'read'>;
    readEnvironment(signal: AbortSignal): Promise<DeploymentEnvironmentDetailV1>;
    readHealthAlertSource?: (sourceInstanceId: string) => Promise<SavedHealthCheckSourceRead>;
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
    if (!accountId) throw createActionExecuteFailureError({ ok: false, errorCode: 'notice_account_scope_mismatch', error: 'notice_account_scope_mismatch' });
    const services = input.handles.map(handle => {
        const subject = MachineDeploymentServiceIdentityV1Schema.parse(handle.identity);
        if (subject.machineId !== input.machineId || subject.environmentId !== input.environment.environment.id
            || handle.serverId !== input.homeServerIdentityId) throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
        return { handle, subject };
    });
    const controller = new AbortController();
    const store = createCredentialedAccountArtifactStore(input.credentials);
    const deliver = createCommittedServiceHealthDelivery(input);
    const cleanups: Array<() => void> = [];
    let admittedEnvironment: DeploymentEnvironmentDetailV1 | null = null;
    let receiptHistory: readonly DeploymentReceiptDetailV1[] = [];
    const serviceRows = input.serviceRows ?? input.nativeWorkload?.rows;
    const readRows = () => (input.nativeWorkload?.handles ?? input.handles).flatMap(handle => {
        const row = serviceRows?.read(handle);
        return row ? [row] : [];
    });
    const recoveryChoices = (environment: DeploymentEnvironmentDetailV1, rows: readonly MachineServiceRowV1[]) => {
        const choices: AccountNoticeRecoveryChoiceV1[] = [];
        const row = rows.find(row => row.capabilities.restart && row.deployment && row.generation);
        const deployment = row?.deployment;
        const targetLinkId = environment.environment.runtimeTargetLinkId;
        if (row?.generation && deployment && targetLinkId) choices.push({ actionId: 'deployments.restart', label: 'Restart service',
            input: { serverId: input.serverId, environmentId: deployment.service.environmentId,
                deploymentId: deployment.deploymentId, targetLinkId, machineId: deployment.service.machineId,
                installationId: deployment.installationId, service: deployment.service, expectedGeneration: row.generation } });
        const rollback = deploymentNoticeRollbackChoice(environment, input.recoveryReceipt, receiptHistory);
        if (rollback) choices.push(rollback);
        return choices.length ? { recoveryChoices: choices } : {};
    };
    const readMachineLabels = (machineIds: readonly string[], signal: AbortSignal) => readDeploymentNoticeMachineLabels({
        credentials: input.credentials, token: input.credentials.token, serverHttpBaseUrl: input.serverHttpBaseUrl, machineIds, signal });
    const readAlertDelivery = async () => {
        const source = await input.readHealthAlertSource?.(createHealthCheckSourceInstanceIdV1({
            kind: 'environment', environmentId: input.environment.environment.id,
        })) ?? { kind: 'unavailable' as const, code: 'health_check_source_unavailable' };
        if (source.kind === 'available') {
            const selection = projectSavedHealthAlertSelection(source);
            return selection.kind === 'active' ? { kind: 'available' as const, alerts: selection.alerts } : selection;
        }
        return source.kind === 'unconfigured' ? { kind: 'available' as const, alerts: undefined } : source;
    };
    let health = input.health;
    const currentHealth = () => !controller.signal.aborted && health?.isCurrent() === true;
    const retainedHandles = input.nativeWorkload?.handles ?? input.handles;
    const installationId = input.nativeWorkload?.installationId ?? retainedHandles[0]?.release.installationId;
    const environmentId = input.environment.environment.id;
    const isRetained = (handle: (typeof retainedHandles)[number]) => !handle.retirementSignal.aborted && handle.isCurrent();
    let pending = Promise.resolve();
    let releaseServingSubscription: (() => void) | undefined;

    const reportAdmissionFailure = (error: unknown) => {
        if (!controller.signal.aborted) logger.warnLocalFile('[deploymentHealth] Notice admission failed', {
            failureCause: projectActionFailureCauseV1(error, 'deployment.notice.admission', { allowUnknownErrorCode: false }),
        });
    };
    const stopWaitingForServing = () => {
        releaseServingSubscription?.();
        releaseServingSubscription = undefined;
    };
    function waitForServing() {
        if (releaseServingSubscription || !retainedHandles.some(isRetained)) return;
        const currentness = acquireRequesterAccountEncryptionCurrentness({
            accountId, token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl,
        });
        // Settlement already publishes this Environment after changing its members.
        const unsubscribe = currentness.subscribeEnvironmentAccess(event => {
            if (event.kind !== 'reset' && (event.kind !== 'changes' || !event.environmentIds.includes(environmentId))) return;
            pending = pending.catch(() => {}).then(async () => {
                if (releaseServingSubscription) await admit();
            });
            void pending.catch(reportAdmissionFailure);
        });
        const retire = () => { if (!retainedHandles.some(isRetained)) stopWaitingForServing(); };
        releaseServingSubscription = () => {
            unsubscribe();
            for (const handle of retainedHandles) handle.retirementSignal.removeEventListener('abort', retire);
            void currentness.dispose().catch(reportAdmissionFailure);
        };
        for (const handle of retainedHandles) handle.retirementSignal.addEventListener('abort', retire, { once: true });
    }
    async function admit() {
        if (controller.signal.aborted || admittedEnvironment) return;
        const waitingForServing = releaseServingSubscription !== undefined;
        const fresh = await input.readEnvironment(controller.signal);
        const environment = fresh.environment;
        if (controller.signal.aborted || environment.id !== environmentId || environment.serverId !== input.serverId
            || environment.projectSourceId !== input.environment.environment.projectSourceId
            || environment.runtimeTargetLinkId !== input.environment.environment.runtimeTargetLinkId || !environment.capabilities.read) {
            stopWaitingForServing();
            return;
        }
        const targetLink = fresh.targetLinks.find(({ targetLink }) => targetLink.id === environment.runtimeTargetLinkId)?.targetLink;
        const member = targetLink?.members.find(member => member.machineId === input.machineId
            && (installationId === undefined || member.installationId === installationId));
        if (member?.state === 'joining') {
            waitForServing();
            return;
        }
        const becameServing = !waitingForServing || retainedHandles.some(handle =>
            isRetained(handle) && handle.deploymentId === targetLink?.activeDeploymentId);
        stopWaitingForServing();
        if (member?.state !== 'active' || !becameServing) return;

        admittedEnvironment = fresh;
        // Attaching replays the retained service owner's last native state.
        // A stop observed while joining is therefore visible once serving.
        for (const service of services) attachService(service);
        if (health) attachHealth(health, accountId);
        const native = input.nativeWorkload;
        if (!native || environment.controllerMachineId !== input.machineId) return;
        receiptHistory = await readDeploymentNoticeHistory(native.receipts(fresh, controller.signal));
        const owned = await observeNativeWorkload({ environment: fresh,
            receipts: (async function* () { yield* receiptHistory; })(), signal: controller.signal, observedAtMs: Date.now(),
            ...(native.edge ? { edge: native.edge } : {}),
            local: { machineId: input.machineId, installationId: native.installationId,
                rows: native.rows,
                resolve: identity => native.handles.find(handle => handle.serverId === input.homeServerIdentityId
                    && handle.identity.composeService === identity.composeService && handle.identity.environmentId === identity.environmentId
                    && handle.identity.machineId === identity.machineId) ?? null },
        });
        if (!owned) return;
        if (controller.signal.aborted) {
            owned.dispose();
            return;
        }
        health = owned;
        cleanups.push(() => owned.dispose());
        attachHealth(owned, accountId);
    }
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
                const alertDelivery = await readAlertDelivery();
                const rows = readRows();
                const affectedRows = rows.filter(row => row.health?.status !== 'up' && row.health?.expectedDown !== 'stop');
                const labels = await readMachineLabels(aggregate.members.map(member => member.machineId), signal);
                if (!currentHealth()) return;
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
                    ...(!recovered && !expectedStop ? recoveryChoices(fresh, affectedRows) : {}),
                    body: [...aggregate.members.flatMap(member => member.evidence.filter(evidence => evidence.status !== 'up')
                        .map(evidence => {
                            const names = evidence.role === 'runtime' ? affectedRows.filter(row => row.deployment?.service.machineId === member.machineId)
                                .map(row => row.name) : [];
                            return `${labels.get(member.machineId) ?? 'Machine name unavailable'} ${evidence.role}${names.length ? ` (${names.join(', ')})` : ''}: ${evidence.status}${evidence.reason ? ` (${evidence.reason})` : ''}.`;
                        })),
                        ...(alertDelivery?.kind === 'unavailable' ? [`Off-app alert settings are unavailable (${alertDelivery.code}).`] : []),
                    ].join(' '),
                    signal,
                }));
                if (!committed.changed || !committed.healthOpening || !currentHealth()) return;
                const current = health.snapshot();
                if (recovered ? !current.authoritativeRecovery : current.down === 0 && current.degraded === 0) return;
                if (alertDelivery?.kind === 'available') await deliver({ receipt: committed, signal,
                    controllerMachineId: fresh.environment.controllerMachineId, alerts: alertDelivery.alerts });
            });
            void pending.catch(error => {
                if (!signal.aborted) logger.warnLocalFile('[deploymentHealth] Aggregate notice write failed', {
                    failureCause: projectActionFailureCauseV1(error, 'deployment.notice.aggregate_write', { allowUnknownErrorCode: false }),
                });
            });
        });
        const retire = () => observation.dispose();
        health.retirementSignal.addEventListener('abort', retire, { once: true });
        cleanups.push(() => { observation.dispose(); health.retirementSignal.removeEventListener('abort', retire); });
    }
    function attachService({ handle, subject }: (typeof services)[number]) {
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
                const alertDelivery = await readAlertDelivery();
                if (!isCurrent()) return;
                const expectedStop = snapshot.expectedDown === 'stop';
                const recovered = snapshot.state === 'healthy' && !expectedStop;
                const row = serviceRows?.read(handle);
                const labels = await readMachineLabels([subject.machineId], signal);
                if (!isCurrent()) return;
                const committed = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => store.writeNotice({
                    accountId, source: { kind: 'host', topic: 'service_health', subject },
                    page: { kind: 'host', page: 'machine_service', service: subject,
                        machine: { serverId: input.serverId, machineId: subject.machineId },
                        environment: { serverId: input.serverId, projectSourceId: fresh.environment.projectSourceId,
                            environmentId: subject.environmentId } },
                    title: `${subject.composeService} ${expectedStop ? 'expected during stop' : recovered ? 'recovered' : 'needs attention'}`,
                    type: !recovered && !expectedStop && fresh.environment.protection === 'production' ? 'blocked' : 'update',
                    healthPhase: recovered ? 'recovered' : 'open', resolved: false,
                    ...(!recovered && !expectedStop ? recoveryChoices(fresh, row ? [row] : []) : {}),
                    body: [`${labels.get(subject.machineId) ?? 'Machine name unavailable'}: ${row?.name ?? handle.composeService}. Service health: ${snapshot.state}.`,
                        ...(snapshot.readiness ? [`Readiness: ${snapshot.readiness.replaceAll('_', ' ')}.`] : []),
                        ...(snapshot.nativePhase ? [`Native phase: ${snapshot.nativePhase.replaceAll('_', ' ')}.`] : []),
                        ...(alertDelivery?.kind === 'unavailable' ? [`Off-app alert settings are unavailable (${alertDelivery.code}).`] : []),
                    ].join(' '),
                    signal,
                }));
                if (!committed.changed || !committed.healthOpening) return;
                // Read the service owner's cached fact, never run another probe.
                const openingCurrent = () => isCurrent() && (recovered
                    ? handle.snapshot().state === 'healthy'
                    : ['unhealthy', 'failed', 'stopped'].includes(handle.snapshot().state));
                if (!openingCurrent()) return;
                if (alertDelivery?.kind === 'available') await deliver({ receipt: committed, signal,
                    controllerMachineId: fresh.environment.controllerMachineId, alerts: alertDelivery.alerts });
            });
            // Keep failures observable without an unhandled background rejection.
            // A later genuine owner transition can progress; there is no retry timer.
            void pending.catch(error => {
                if (!signal.aborted) logger.warnLocalFile('[deploymentHealth] Notice write failed', {
                    failureCause: projectActionFailureCauseV1(error, 'deployment.notice.service_write', { allowUnknownErrorCode: false }),
                });
            });
        });
        const retire = () => observation.dispose();
        handle.retirementSignal.addEventListener('abort', retire, { once: true });
        cleanups.push(() => { observation.dispose(); handle.retirementSignal.removeEventListener('abort', retire); });
    }
    if (services.length > 0 || currentHealth() || input.nativeWorkload) {
        pending = admit();
        void pending.catch(reportAdmissionFailure);
    }
    return {
        dispose() {
            controller.abort();
            stopWaitingForServing();
            for (const cleanup of cleanups) cleanup();
        },
        async settled() {
            let tail: Promise<void>;
            do { tail = pending; await tail; } while (tail !== pending);
        },
    };
}
