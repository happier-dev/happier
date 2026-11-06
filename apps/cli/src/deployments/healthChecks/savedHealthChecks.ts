import type { HealthChecksService } from '@happier-dev/plugin-sdk';
import { z } from 'zod/mini';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import { DeploymentDomainMutationResultV1Schema, DeploymentEnvironmentGetResultV1Schema,
    type DeploymentDomainHeaderV1, type DeploymentEnvironmentHeaderV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { HealthCheckResultV1 } from '@happier-dev/deployment-protocol/v1';
import { HEALTH_CHECK_KINDS_V1, HealthCheckDomainHttpConfigV1Schema, HealthCheckServiceHttpConfigV1Schema, HealthCheckTcpConfigV1Schema,
    type HealthCheckDefinitionV1,
    HealthCheckDnsConfigV1Schema, HealthCheckHeartbeatConfigV1Schema, SavedHealthCheckSelectorV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { isHealthCheckLoopbackRefusedV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { ResolveAutomationEventAdoptedDefinitionSetV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { readAdoptedHealthCheckBatch } from './readAdoptedHealthCheckBatch';
import { readCertificateHealthCheckV1, readHttpHealthCheckV1, type AdmittedHttpHealthCheckV1 } from './finiteHttpHealthCheck';
import { readDnsHealthCheckV1, readTcpHealthCheckV1 } from './finiteNetworkHealthCheck';
import { readHeartbeatHealthCheckV1 } from './finiteHeartbeatHealthCheck';
import { PLUGIN_SERVICE_DESCRIPTORS } from '@/plugins/runtime/invocation/services/unavailable';

function unavailable(code: string): never {
    throw new PluginError({ code, message: 'The saved health check is unavailable', retryable: false });
}

function missingDomainServingAddress(cause?: unknown): never {
    throw new PluginError({ code: 'deployment_unavailable',
        message: 'The app has no available Domain serving address for this health check.', retryable: false,
        details: { requiredFact: 'domainServingAddress',
            remedy: 'Deploy the app successfully, then add its Domain before setting up this health check.' },
    }, { cause });
}

/** One finite admission over the existing adopted source and live service read. */
export function createSavedHealthChecksHost(input: Readonly<{
    serverId: string;
    resolveAdoptedDefinitionSet: ResolveAutomationEventAdoptedDefinitionSetV1;
    readObserver(): Readonly<{ machineId: string; installationId: string }> | null;
    openDomainArtifact(artifactId: string, signal: AbortSignal): Promise<DeploymentArtifactDocumentV1 | null>;
    onDomainResult?(input: Readonly<{ sourceInstanceId: string; sourceRevision: string;
        caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
        checkId: string; kind: 'http' | 'certificate';
        subject: Readonly<{ kind: 'environment'; environmentId: string }>;
        environment: DeploymentEnvironmentHeaderV1; targetLink: DeploymentTargetLinkHeaderV1;
        domain: DeploymentDomainHeaderV1; observer: Readonly<{ machineId: string; installationId: string }>;
        result: HealthCheckResultV1; signal: AbortSignal }>): Promise<void> | void;
    now?(): number;
    enrollHeartbeat?(input: Readonly<{ caller: PluginMachineMaterializationRefV1; sourceInstanceId: string;
        checkId: string; heartbeatContributionId: string }>, signal: AbortSignal): Promise<Readonly<{ webhookEndpointId: string }>>;
    readHeartbeatReceipt?(input: Readonly<{ caller: PluginMachineMaterializationRefV1; sourceInstanceId: string;
        checkId: string; webhookEndpointId: string }>, signal: AbortSignal): Promise<
        Readonly<{ kind: 'ready'; lastAcceptedAt: number | null }>
        | Readonly<{ kind: 'unavailable'; code: 'endpoint_unavailable' }>>;
}>) {
    return Object.freeze({
        bind(seed: PluginInvocationServicesSeed, services: Readonly<{ actions: ActionsService; http: HttpService }>): HealthChecksService | null {
            if (!seed.resolveCurrentPluginMaterializationRef) return null;
            const readEnvironment = async (environmentId: string, signal: AbortSignal) => {
                const loaded = await services.actions.execute('deployments.environments.get',
                    { serverId: input.serverId, environmentId }, { signal });
                signal.throwIfAborted();
                const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
                if (!detail.ok) return unavailable(detail.error);
                // The deployment Action admits the exact Home; its portable id can differ from this local profile id.
                if (detail.environment.id !== environmentId || detail.environment.deletedAtMs !== undefined) {
                    return unavailable('health_check_subject_mismatch');
                }
                if (!detail.environment.capabilities.manage) return unavailable('deployment_access_denied');
                return detail;
            };
            const readDomain = async (environment: Awaited<ReturnType<typeof readEnvironment>>,
                domainId: string, targetLinkId: string, signal: AbortSignal) => {
                const targetLink = environment.targetLinks.find(link => link.id === targetLinkId);
                if (!targetLink || targetLink.environmentId !== environment.environment.id || targetLink.deletedAtMs !== undefined) {
                    return unavailable('health_check_subject_mismatch');
                }
                const loaded = await services.actions.execute('deployments.domains.get',
                    { serverId: input.serverId, environmentId: environment.environment.id, domainId }, { signal }).catch(error => {
                    if (isPluginError(error) && error.code === 'deployment_unavailable') return missingDomainServingAddress(error);
                    throw error;
                });
                signal.throwIfAborted();
                const detail = DeploymentDomainMutationResultV1Schema.parse(loaded);
                if (!detail.ok) {
                    if (detail.error === 'deployment_unavailable') return missingDomainServingAddress(detail);
                    return unavailable(detail.error);
                }
                const domain = detail.domain;
                if (detail.environmentId !== environment.environment.id || domain.id !== domainId
                    || domain.environmentId !== environment.environment.id || domain.targetLinkId !== targetLinkId
                    || domain.deletedAtMs !== undefined) return unavailable('health_check_subject_mismatch');
                const opened = readDeploymentDomainArtifactV1(domain,
                    await input.openDomainArtifact(domain.contentArtifactId, signal));
                signal.throwIfAborted();
                if (!opened.ok) return unavailable(opened.error);
                return { domain, targetLink, content: opened.content };
            };
            return Object.freeze({
                async setup(request: Parameters<HealthChecksService['setup']>[0], options?: Parameters<HealthChecksService['setup']>[1]) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    const caller = seed.resolveCurrentPluginMaterializationRef?.();
                    if (!seed.isOccurrenceCurrent() || !caller) return unavailable('source_unavailable');
                    if (request.sourceConfig.subject.kind === 'environment') {
                        const environment = await readEnvironment(request.sourceConfig.subject.environmentId, signal);
                        const domains = new Map<string, Promise<Awaited<ReturnType<typeof readDomain>>>>();
                        for (const check of request.sourceConfig.checks) {
                            if (check.binding.kind === 'healthCheck') continue;
                            if ((check.kind.localId !== 'http' && check.kind.localId !== 'certificate')
                                || !HealthCheckDomainHttpConfigV1Schema.safeParse(check.config).success) {
                                return unavailable('source_config_invalid');
                            }
                            const key = `${check.binding.targetLinkId}:${check.binding.domainId}`;
                            if (!domains.has(key)) domains.set(key, readDomain(environment,
                                check.binding.domainId, check.binding.targetLinkId, signal));
                        }
                        await Promise.all(domains.values());
                    }
                    if (!request.sourceConfig.checks.some(check => check.kind.pluginId === seed.plugin.id && check.kind.localId === 'heartbeat')) {
                        return request.sourceConfig;
                    }

                    const enroll = input.enrollHeartbeat;
                    if (!enroll) return PLUGIN_SERVICE_DESCRIPTORS.healthChecks.createUnavailable('setup_unavailable').setup(request, options);
                    const heartbeatDraft = z.partial(HealthCheckHeartbeatConfigV1Schema, { webhookEndpointId: true });
                    // Validate the whole explicit setup before creating any endpoint.
                    const configured = request.sourceConfig.checks.map(check => {
                        if (check.kind.pluginId !== seed.plugin.id || check.kind.localId !== 'heartbeat') return { check };
                        const config = heartbeatDraft.safeParse(check.config);
                        if (!config.success) return unavailable('source_config_invalid');
                        return { check, config: config.data };
                    });
                    const checks = await Promise.all(configured.map(async ({ check, config }) => {
                        if (!config) return check;
                        const endpoint = await enroll({ caller, sourceInstanceId: request.sourceInstanceId,
                            checkId: check.checkId, heartbeatContributionId: request.heartbeatContributionId }, signal);
                        signal.throwIfAborted();
                        return { ...check, config: HealthCheckHeartbeatConfigV1Schema.parse({
                            ...config, webhookEndpointId: endpoint.webhookEndpointId }) };
                    }));
                    return { ...request.sourceConfig, checks };
                },
                async read(request: Parameters<HealthChecksService['read']>[0], options?: Parameters<HealthChecksService['read']>[1]) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    if (!seed.isOccurrenceCurrent()) return unavailable('source_unavailable');
                    const caller = seed.resolveCurrentPluginMaterializationRef?.();
                    const observer = input.readObserver();
                    if (!caller || !observer || caller.machineId !== observer.machineId) return unavailable('source_unavailable');
                    const selectors = request.checkIds.map(checkId => SavedHealthCheckSelectorV1Schema.parse({
                        sourceInstanceId: request.sourceInstanceId, checkId,
                    }));
                    if (!selectors.length) return [];
                    if (new Set(selectors.map(value => value.checkId)).size !== selectors.length) return unavailable('source_config_invalid');
                    const batch = readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: input.resolveAdoptedDefinitionSet,
                        caller, occurrenceId: seed.occurrenceId, sourceInstanceId: request.sourceInstanceId, signal });
                    if (batch.kind !== 'available') return unavailable(batch.reason);
                    const subject = batch.source.subject;
                    const checks = selectors.map(selector => {
                        const check = batch.source.checks.find(candidate => candidate.checkId === selector.checkId);
                        if (!check || check.kind.pluginId !== seed.plugin.id
                            || !HEALTH_CHECK_KINDS_V1.some(kind => kind === check.kind.localId)) return unavailable('health_check_kind_unavailable');
                        if (seed.contribution.id.startsWith('health/') && seed.contribution.id !== `health/${check.kind.localId}`) {
                            return unavailable('health_check_kind_unavailable');
                        }
                        return check;
                    });
                    const readHeartbeat = async (checkId: string,
                        value: Omit<Parameters<typeof readHeartbeatHealthCheckV1>[0], 'lastAcceptedAt'>
                            & Readonly<{ webhookEndpointId: string }>) => {
                        if (!input.readHeartbeatReceipt) return unavailable('endpoint_unavailable');
                        const receipt = await input.readHeartbeatReceipt({ caller, sourceInstanceId: request.sourceInstanceId,
                            checkId, webhookEndpointId: value.webhookEndpointId }, signal);
                        signal.throwIfAborted();
                        if (receipt.kind !== 'ready') return unavailable(receipt.code);
                        return { checkId, ...readHeartbeatHealthCheckV1({ ...value,
                            lastAcceptedAt: receipt.lastAcceptedAt }, (input.now ?? Date.now)()) };
                    };
                    if (subject.kind === 'environment') {
                        const environment = await readEnvironment(subject.environmentId, signal);
                        if (environment.environment.controllerMachineId !== observer.machineId) {
                            return unavailable('health_check_subject_mismatch');
                        }
                        const domains = new Map<string, Promise<Awaited<ReturnType<typeof readDomain>>>>();
                        const admitted = await Promise.all(checks.map(async check => {
                            if (check.kind.localId === 'heartbeat' && check.binding.kind === 'healthCheck') {
                                const config = HealthCheckHeartbeatConfigV1Schema.safeParse(check.config);
                                if (!config.success) return unavailable('source_config_invalid');
                                return { kind: 'heartbeat' as const, check, value: { ...config.data,
                                    observer, vantage: 'sameMachine' as const, periodMs: check.periodMs } };
                            }
                            if (check.binding.kind === 'healthCheck'
                                || (check.kind.localId !== 'http' && check.kind.localId !== 'certificate')) {
                                return unavailable('health_check_subject_unavailable');
                            }
                            const key = `${check.binding.targetLinkId}:${check.binding.domainId}`;
                            let domain = domains.get(key);
                            if (!domain) {
                                domain = readDomain(environment, check.binding.domainId, check.binding.targetLinkId, signal);
                                domains.set(key, domain);
                            }
                            const current = await domain;
                            const config = HealthCheckDomainHttpConfigV1Schema.safeParse(check.config);
                            if (!config.success) return unavailable('source_config_invalid');
                            return { kind: 'domain' as const, check, current, value: {
                                sourceInstanceId: request.sourceInstanceId, checkId: check.checkId, subject,
                                observer, vantage: environment.environment.ingress?.kind === 'edgeCaddy'
                                    && environment.environment.ingress.edgeMachineId === observer.machineId
                                    ? 'sameMachine' as const : 'outside' as const,
                                target: { kind: 'domain' as const, environmentId: subject.environmentId,
                                    targetLinkId: current.targetLink.id, domainId: current.domain.id,
                                    domainRevision: current.domain.revision, targetLinkRevision: current.targetLink.revision,
                                    hostname: current.content.hostname, healthCheck: current.content.healthCheck },
                                ...(config.data.keyword === undefined ? {} : { keyword: config.data.keyword }),
                            } satisfies AdmittedHttpHealthCheckV1 };
                        }));
                        const context = { signal, http: services.http, now: input.now ?? Date.now,
                            isCurrent: async () => !signal.aborted };
                        const results = await Promise.all(admitted.map(async item => item.kind === 'heartbeat'
                            ? readHeartbeat(item.check.checkId, item.value)
                            : { checkId: item.check.checkId, result: await (item.check.kind.localId === 'http'
                                ? readHttpHealthCheckV1 : readCertificateHealthCheckV1)(item.value, context) }));
                        signal.throwIfAborted();
                        for (let index = 0; index < admitted.length; index++) {
                            signal.throwIfAborted();
                            const item = admitted[index]!;
                            if (item.kind !== 'domain') continue;
                            await input.onDomainResult?.({ sourceInstanceId: request.sourceInstanceId, sourceRevision: batch.revision,
                                caller, occurrenceId: seed.occurrenceId, check: item.check,
                                checkId: item.check.checkId,
                                kind: item.check.kind.localId as 'http' | 'certificate', subject,
                                environment: environment.environment, targetLink: item.current.targetLink,
                                domain: item.current.domain, observer, result: results[index]!.result, signal });
                        }
                        return results;
                    }
                    const detail = await services.actions.execute('machines.services.detail', {
                        serverId: input.serverId, machineId: subject.machineId, serviceId: subject.serviceId,
                    }, { signal });
                    signal.throwIfAborted();
                    if (!('kind' in detail) || detail.kind !== 'service' || detail.service.serviceId !== subject.serviceId
                        || detail.service.unavailableReason !== undefined) return unavailable('service_unavailable');
                    const vantage = observer.machineId === subject.machineId ? 'sameMachine' as const : 'outside' as const;
                    const admitted = checks.map(check => {
                        const basis = { observer, vantage };
                        if (check.kind.localId === 'tcp') {
                            const config = HealthCheckTcpConfigV1Schema.safeParse(check.config);
                            if (!config.success) return unavailable('source_config_invalid');
                            if (isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: observer.machineId,
                                kindLocalId: check.kind.localId, config: config.data })) return unavailable('health_check_subject_mismatch');
                            return { kind: 'tcp' as const, checkId: check.checkId, value: { ...basis, ...config.data } };
                        }
                        if (check.kind.localId === 'dns') {
                            const config = HealthCheckDnsConfigV1Schema.safeParse(check.config);
                            if (!config.success) return unavailable('source_config_invalid');
                            return { kind: 'dns' as const, checkId: check.checkId, value: { ...basis, ...config.data } };
                        }
                        if (check.kind.localId === 'heartbeat') {
                            const config = HealthCheckHeartbeatConfigV1Schema.safeParse(check.config);
                            if (!config.success) return unavailable('source_config_invalid');
                            return { kind: 'heartbeat' as const, checkId: check.checkId,
                                value: { ...basis, ...config.data, periodMs: check.periodMs } };
                        }
                        const config = HealthCheckServiceHttpConfigV1Schema.safeParse(check.config);
                        if (!config.success) return unavailable('source_config_invalid');
                        if (isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: observer.machineId,
                            kindLocalId: check.kind.localId, config: config.data })) {
                            return unavailable('health_check_subject_mismatch');
                        }
                        return { kind: 'httpOrCertificate' as const, checkId: check.checkId, kindId: check.kind.localId,
                            value: { sourceInstanceId: request.sourceInstanceId,
                            checkId: check.checkId, subject, observer, vantage,
                            target: { kind: 'machineService' as const, machineId: subject.machineId, serviceId: subject.serviceId,
                                endpoint: config.data.endpoint, expectStatus: config.data.expectStatus },
                            ...(config.data.keyword === undefined ? {} : { keyword: config.data.keyword }),
                        } satisfies AdmittedHttpHealthCheckV1 };
                    });
                    // Assignment/source edits are adopted at the next finite
                    // boundary. Cancellation remains live through the body.
                    const context = { signal, http: services.http, now: input.now ?? Date.now,
                        isCurrent: async () => !signal.aborted };
                    return Promise.all(admitted.map(async check => {
                        if (check.kind === 'tcp') return { checkId: check.checkId, result: await readTcpHealthCheckV1(check.value, context) };
                        if (check.kind === 'dns') return { checkId: check.checkId, result: await readDnsHealthCheckV1(check.value, context) };
                        if (check.kind === 'heartbeat') return readHeartbeat(check.checkId, check.value);
                        return { checkId: check.checkId,
                            result: await (check.kindId === 'http' ? readHttpHealthCheckV1 : readCertificateHealthCheckV1)(check.value, context) };
                    }));
                },
            });
        },
    });
}
