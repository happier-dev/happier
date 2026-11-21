import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { deploymentUnavailableDiagnostic } from '../deploymentFailure';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { AccountSettings } from '@happier-dev/protocol';
import type { SavedHealthCheckSourceRead } from './readSavedHealthCheckSource';
import { HealthCheckSetupPreviewResultV1Schema, type HealthCheckSetupPreviewInputV1, type HealthCheckSetupPreviewResultV1, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { HealthChecksService, HealthCheckKindCatalogV1 } from '@happier-dev/plugin-sdk';
import { z } from 'zod/mini';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import { DeploymentDomainMutationResultV1Schema, DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentUpdateResultV1Schema,
    type DeploymentDomainHeaderV1, type DeploymentEnvironmentHeaderV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import type { HealthCheckResultV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { HEALTH_CHECK_KINDS_V1, HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HealthCheckResultV1Schema, HealthCheckDomainHttpConfigV1Schema,
    type HealthCheckDefinitionV1,
    HealthCheckHeartbeatConfigV1Schema, SavedHealthCheckSelectorV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { ResolveAutomationEventAdoptedDefinitionSetV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { readAdoptedHealthCheckBatch } from './readAdoptedHealthCheckBatch';
import { readCertificateHealthCheckV1, readHttpHealthCheckV1, type AdmittedHttpHealthCheckV1 } from './finiteHttpHealthCheck';
import { admitSavedEndpointCheck, readSavedEndpointCheck } from './savedEndpointCheck';
import { readHeartbeatHealthCheckV1 } from './finiteHeartbeatHealthCheck';
import { PLUGIN_SERVICE_DESCRIPTORS } from '@/plugins/runtime/invocation/services/unavailable';
import { resolveDeploymentCreationDefaultsV1, deploymentDomainProbeVantageV1 } from '@happier-dev/deployments';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

function builtin(check: HealthCheckDefinitionV1): boolean {
    return check.kind.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1
        && HEALTH_CHECK_KINDS_V1.some(kind => kind === check.kind.localId);
}

function contributed(check: HealthCheckDefinitionV1, kinds: HealthCheckKindCatalogV1) {
    const kind = kinds.find(candidate => candidate.pluginId === check.kind.pluginId && candidate.id === check.kind.localId);
    if (!kind) return unavailable('health_check_kind_unavailable');
    if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(kind.configSchema), check.config)) {
        return unavailable('source_config_invalid');
    }
    return kind;
}

function unavailable(code: string, cause?: unknown, phase = 'deployment.health_check'): never {
    const error = new PluginError({ code, message: 'The saved health check is unavailable', retryable: false }, { cause });
    throw code === 'deployment_unavailable' ? deploymentUnavailableDiagnostic(error, phase, 'native_failure', cause) : error;
}

function missingDomainServingAddress(cause?: unknown): never {
    throw deploymentUnavailableDiagnostic(new PluginError({ code: 'deployment_unavailable',
        message: 'The app has no available Domain serving address for this health check.', retryable: false,
        details: { requiredFact: 'domainServingAddress',
            remedy: 'Deploy the app successfully, then add its Domain before setting up this health check.' },
    }, { cause }), 'deployment.health_check.domain.serving_address', 'binding_missing', cause);
}

export type SavedMachineServiceHealthResult = Readonly<{
    serverId: string; sourceInstanceId: string; caller: PluginMachineMaterializationRefV1; occurrenceId: string;
    subject: Readonly<{ kind: 'machineService'; machineId: string; serviceId: string }>;
    generation: string | null; check: HealthCheckDefinitionV1; result: HealthCheckResultV1;
    retirementSignal?: AbortSignal;
}>;

/** One finite admission over the existing adopted source and live service read. */
export function createSavedHealthChecksHost(input: Readonly<{
    /** Local profile for client contexts and service-result publication. */
    serverId: string;
    /** Exact portable Home identity for deployment Actions. */
    homeServerIdentityId: string | null;
    resolveAdoptedDefinitionSet: ResolveAutomationEventAdoptedDefinitionSetV1;
    readKinds?(): HealthCheckKindCatalogV1;
    readSavedSource?(sourceInstanceId: string, signal: AbortSignal): Promise<SavedHealthCheckSourceRead>;
    readAccountSettings?(signal: AbortSignal): Promise<Readonly<{ accountId: string; settings: Pick<AccountSettings, 'deploymentDefaultsV1'> }>>;
    resolveSourceOwner?(): Readonly<{ caller: PluginMachineMaterializationRefV1; occurrenceId: string }> | null;
    readObserver(): Readonly<{ machineId: string; installationId: string }> | null;
    openDomainArtifact(artifactId: string, signal: AbortSignal): Promise<DeploymentArtifactDocumentV1 | null>;
    onServiceResult?(input: SavedMachineServiceHealthResult): Promise<void> | void;
    onDomainResult?(input: Readonly<{ sourceInstanceId: string; sourceRevision: string;
        caller: PluginMachineMaterializationRefV1; occurrenceId: string; check: HealthCheckDefinitionV1;
        checkId: string; kind: 'http' | 'certificate';
        subject: Readonly<{ kind: 'environment'; environmentId: string }>;
        environment: DeploymentEnvironmentHeaderV1; targetLink: DeploymentTargetLinkHeaderV1;
        domain: DeploymentDomainHeaderV1; observer: Readonly<{ machineId: string; installationId: string }>;
        result: HealthCheckResultV1; tlsKind?: 'custom' | 'managed'; signal: AbortSignal }>): Promise<void> | void;
    now?(): number;
    manageHeartbeat?(request: Readonly<{ caller: PluginMachineMaterializationRefV1;
        input: Parameters<HealthChecksService['manageHeartbeat']>[0] }>, signal: AbortSignal): ReturnType<HealthChecksService['manageHeartbeat']>;
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
                if (!input.homeServerIdentityId) return unavailable('server_scope_mismatch');
                const loaded = await services.actions.execute('deployments.environments.get',
                    { serverId: input.homeServerIdentityId, environmentId }, { signal });
                signal.throwIfAborted();
                const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
                if (!detail.ok) return unavailable(detail.error, detail, 'deployment.health_check.environment.read');
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
                    { serverId: environment.environment.serverId, environmentId: environment.environment.id, domainId }, { signal }).catch(error => {
                    if (isPluginError(error) && error.code === 'deployment_unavailable') return missingDomainServingAddress(error);
                    throw error;
                });
                signal.throwIfAborted();
                const detail = DeploymentDomainMutationResultV1Schema.parse(loaded);
                if (!detail.ok) {
                    if (detail.error === 'deployment_unavailable') return missingDomainServingAddress(detail);
                    return unavailable(detail.error, detail, 'deployment.health_check.domain.read');
                }
                const domain = detail.domain;
                if (detail.environmentId !== environment.environment.id || domain.id !== domainId
                    || domain.environmentId !== environment.environment.id || domain.targetLinkId !== targetLinkId
                    || domain.deletedAtMs !== undefined) return unavailable('health_check_subject_mismatch');
                const opened = readDeploymentDomainArtifactV1(domain,
                    await input.openDomainArtifact(domain.contentArtifactId, signal));
                signal.throwIfAborted();
                if (!opened.ok) return refuseDeploymentArtifactRead(opened);
                return { domain, targetLink, content: opened.content };
            };
            type SaveRequest = Parameters<HealthChecksService['setup']>[0];
            type SetupOptions = Parameters<HealthChecksService['setup']>[1];
            type PreviewRequest = Readonly<{ sourceInstanceId: string; sourceConfig: HealthCheckSetupPreviewInputV1 }>;
            function isPreviewRequest(request: PreviewRequest | SaveRequest): request is PreviewRequest {
                return 'mode' in request.sourceConfig;
            }
            function setup(request: PreviewRequest, options?: SetupOptions): Promise<HealthCheckSetupPreviewResultV1>;
            function setup(request: SaveRequest, options?: SetupOptions): Promise<HealthCheckSourceConfigV1>;
            async function setup(request: PreviewRequest | SaveRequest, options?: SetupOptions): Promise<HealthCheckSetupPreviewResultV1 | HealthCheckSourceConfigV1> {
                if (isPreviewRequest(request)) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    const caller = seed.resolveCurrentPluginMaterializationRef?.();
                    if (!seed.isOccurrenceCurrent() || !caller) return unavailable('source_unavailable');
                    const { mode, ...draft } = request.sourceConfig;
                    const saved = await input.readSavedSource?.(request.sourceInstanceId, signal);
                    signal.throwIfAborted();
                    if (saved?.kind === 'unavailable') return unavailable(saved.code, saved, 'deployment.health_check.saved_source.read');
                    const retained = saved?.kind === 'available' ? saved : undefined;
                    const sourceConfig = { ...(retained?.source ?? {}), ...draft };
                    const environment = draft.subject.kind === 'environment' ? await readEnvironment(draft.subject.environmentId, signal) : undefined;
                    if (sourceConfig.alerts === undefined) {
                        let channels: NonNullable<HealthCheckSourceConfigV1['alerts']>['channels'] | undefined;
                        if (environment) {
                            const header = environment.environment;
                            const prepared = DeploymentEnvironmentUpdateResultV1Schema.parse(await services.actions.execute('deployments.environments.update', {
                                serverId: header.serverId, environmentId: header.id, expectedRevision: header.revision,
                                contentArtifactId: header.contentArtifactId, contentHeaderVersion: header.contentHeaderVersion,
                                contentBodyVersion: header.contentBodyVersion, mode: 'preview', defaultsFor: 'alerts',
                            }, { signal }));
                            if (!prepared.ok) return unavailable(prepared.error, prepared, 'deployment.health_check.alerts.prepare');
                            if (!prepared.creationDefaults) return unavailable('account_settings_unavailable');
                            channels = prepared.creationDefaults.values.alertChannels;
                        } else {
                            const account = await input.readAccountSettings?.(signal);
                            if (!account) return unavailable('account_settings_unavailable');
                            channels = resolveDeploymentCreationDefaultsV1({ projectOwner: { kind: 'account', accountId: account.accountId },
                                account: { accountId: account.accountId, defaults: account.settings.deploymentDefaultsV1 },
                                target: { kind: 'ownServer', machines: [] } }).values.alertChannels;
                        }
                        sourceConfig.alerts = { channels: channels ?? [], phases: ['open', 'recovered'] };
                    }
                    signal.throwIfAborted();
                    const usesControllerProbe = sourceConfig.checks === undefined || sourceConfig.checks.some(builtin);
                    const machineId = environment && usesControllerProbe ? environment.environment.controllerMachineId
                        : retained?.observer?.machineId ?? caller.machineId;
                    const testContext = retained && machineId && retained.source.alerts !== undefined
                        && createCanonicalJsonSigningInput(sourceConfig.alerts) === createCanonicalJsonSigningInput(retained.source.alerts)
                        ? { serverId: input.serverId, machineId, sourceInstanceId: retained.sourceInstanceId, expectedSourceRevision: retained.revision } : undefined;
                    return HealthCheckSetupPreviewResultV1Schema.parse({ mode, sourceConfig,
                        ...(machineId ? { destinationSelectionContext: { serverId: input.serverId, machineId } } : {}),
                        ...(testContext ? { testContext } : {}) });
                }
                return saveSetup(request, options);
            }
            async function saveSetup(request: SaveRequest, options?: SetupOptions): Promise<HealthCheckSourceConfigV1> {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    const caller = seed.resolveCurrentPluginMaterializationRef?.();
                    if (!seed.isOccurrenceCurrent() || !caller) return unavailable('source_unavailable');
                    const kinds = input.readKinds?.() ?? [];
                    for (const check of request.sourceConfig.checks) if (!builtin(check)) contributed(check, kinds);
                    if (request.sourceConfig.investigation?.mode === 'auto_start') {
                        // Triage sources derive their field allocation from the full list schemas at
                        // import; only an auto-start investigation needs them, so every process
                        // that hosts plugin runtimes (each Runner) does not pay that at start.
                        const { readTriageSessionHandoffChoicesV1 } = await import('@happier-dev/triage-sources/runtime');
                        const choices = await readTriageSessionHandoffChoicesV1({ executeAction: (ref, args, options) =>
                            services.actions.execute(ref, args, options) }, { task: 'investigate', signal });
                        signal.throwIfAborted();
                        const configuredActionId = request.sourceConfig.investigation.configuredActionId;
                        if (choices.kind !== 'choices' || !choices.actions.some(action =>
                            action.selection.configuredActionId === configuredActionId)) {
                            return unavailable('health_check_investigation_unavailable');
                        }
                    }
                    if (request.sourceConfig.subject.kind === 'environment') {
                        const environment = await readEnvironment(request.sourceConfig.subject.environmentId, signal);
                        const domains = new Map<string, Promise<Awaited<ReturnType<typeof readDomain>>>>();
                        for (const check of request.sourceConfig.checks) {
                            if (check.binding.kind === 'healthCheck') continue;
                            if (builtin(check) && ((check.kind.localId !== 'http' && check.kind.localId !== 'certificate')
                                || !HealthCheckDomainHttpConfigV1Schema.safeParse(check.config).success)) {
                                return unavailable('source_config_invalid');
                            }
                            const key = `${check.binding.targetLinkId}:${check.binding.domainId}`;
                            if (!domains.has(key)) domains.set(key, readDomain(environment,
                                check.binding.domainId, check.binding.targetLinkId, signal));
                        }
                        await Promise.all(domains.values());
                    }
                    const capabilityContribution = (check: HealthCheckDefinitionV1) => check.kind.pluginId !== seed.plugin.id ? undefined
                        : check.kind.localId === 'heartbeat' ? request.heartbeatContributionId
                            : request.capabilityWebhookContributions?.[check.kind.localId];
                    if (!request.sourceConfig.checks.some(check => capabilityContribution(check))) {
                        return request.sourceConfig;
                    }

                    const enroll = input.enrollHeartbeat;
                    if (!enroll) return PLUGIN_SERVICE_DESCRIPTORS.healthChecks.createUnavailable('setup_unavailable').setup(request, options);
                    const heartbeatDraft = z.partial(HealthCheckHeartbeatConfigV1Schema, { webhookEndpointId: true });
                    // Validate the whole explicit setup before creating any endpoint.
                    const configured = request.sourceConfig.checks.map(check => {
                        const contribution = capabilityContribution(check);
                        if (!contribution) return { check };
                        if (check.kind.localId !== 'heartbeat') {
                            if (typeof check.config !== 'object' || check.config === null || Array.isArray(check.config)) {
                                return unavailable('source_config_invalid');
                            }
                            return { check, contribution, config: check.config };
                        }
                        const config = heartbeatDraft.safeParse(check.config);
                        if (!config.success) return unavailable('source_config_invalid');
                        return { check, contribution, config: config.data };
                    });
                    const checks = await Promise.all(configured.map(async ({ check, config, contribution }) => {
                        if (!config) return check;
                        const endpoint = await enroll({ caller, sourceInstanceId: request.sourceInstanceId,
                            checkId: check.checkId, heartbeatContributionId: contribution! }, signal);
                        signal.throwIfAborted();
                        const mapped = { ...config, webhookEndpointId: endpoint.webhookEndpointId };
                        return { ...check, config: check.kind.localId === 'heartbeat' ? HealthCheckHeartbeatConfigV1Schema.parse(mapped)
                            : { ...mapped, observingSince: (input.now ?? Date.now)() } };
                    }));
                    return { ...request.sourceConfig, checks };
            }
            return Object.freeze({
                async listKinds(options?: Parameters<HealthChecksService['listKinds']>[0]) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    if (!seed.isOccurrenceCurrent()) return unavailable('source_unavailable');
                    return input.readKinds?.() ?? [];
                },
                async readSource(request: Parameters<HealthChecksService['readSource']>[0], options?: Parameters<HealthChecksService['readSource']>[1]) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    if (!seed.isOccurrenceCurrent()) return unavailable('source_unavailable');
                    const own = seed.resolveCurrentPluginMaterializationRef?.();
                    if (!own) return unavailable('source_unavailable');
                    // All producers borrow the one current health observer's adopted source;
                    // external Action callers do not need to know its occurrence or materialization.
                    const owner = input.resolveSourceOwner ? input.resolveSourceOwner()
                        : { caller: own, occurrenceId: seed.occurrenceId };
                    if (!owner) return unavailable('source_unavailable');
                    const batch = readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: input.resolveAdoptedDefinitionSet,
                        ...owner, sourceInstanceId: request.sourceInstanceId, signal });
                    return batch.kind === 'available' ? batch.source : unavailable(batch.reason);
                },
                async manageHeartbeat(request: Parameters<HealthChecksService['manageHeartbeat']>[0], options?: Parameters<HealthChecksService['manageHeartbeat']>[1]) {
                    const signal = options?.signal ? AbortSignal.any([seed.signal, options.signal]) : seed.signal;
                    signal.throwIfAborted();
                    const caller = seed.resolveCurrentPluginMaterializationRef?.();
                    if (!seed.isOccurrenceCurrent() || !caller) return unavailable('source_unavailable');
                    return input.manageHeartbeat ? input.manageHeartbeat({ caller, input: request }, signal)
                        : PLUGIN_SERVICE_DESCRIPTORS.healthChecks.createUnavailable('endpoint_unavailable').manageHeartbeat(request, options);
                },
                setup,
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
                    const kinds = input.readKinds?.() ?? [];
                    const contributions = new Map<string, HealthCheckKindCatalogV1[number]>();
                    const checks = selectors.map(selector => {
                        const check = batch.source.checks.find(candidate => candidate.checkId === selector.checkId);
                        if (!check) return unavailable('health_check_kind_unavailable');
                        if (!builtin(check)) contributions.set(check.checkId, contributed(check, kinds));
                        if (seed.contribution.id.startsWith('health/') && builtin(check)
                            && seed.contribution.id !== `health/${check.kind.localId}`) {
                            return unavailable('health_check_kind_unavailable');
                        }
                        return check;
                    });
                    const readContributed = async (check: HealthCheckDefinitionV1) => {
                        const kind = contributions.get(check.checkId)!;
                        const result = await services.actions.execute({ pluginId: kind.pluginId, localId: kind.action }, {
                            sourceInstanceId: request.sourceInstanceId, checkId: check.checkId,
                        }, { signal });
                        signal.throwIfAborted();
                        return { checkId: check.checkId, result: HealthCheckResultV1Schema.parse(result) };
                    };
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
                        // Built-in endpoint/Domain probes run from the Environment controller.
                        // Contributed checks own their saved observer placement (for example a
                        // collector); the adopted source already admits that observer.
                        if (environment.environment.controllerMachineId !== observer.machineId
                            && checks.some(check => !contributions.has(check.checkId))) {
                            return unavailable('health_check_subject_mismatch');
                        }
                        const domains = new Map<string, Promise<Awaited<ReturnType<typeof readDomain>>>>();
                        const admitted = await Promise.all(checks.map(async check => {
                            if (check.binding.kind === 'healthCheck') {
                                if (contributions.has(check.checkId)) return { kind: 'contributed' as const, check };
                                return { kind: 'endpoint' as const, check, value: admitSavedEndpointCheck({
                                    sourceInstanceId: request.sourceInstanceId, check, subject, observer, vantage: 'sameMachine',
                                }) };
                            }
                            if (!contributions.has(check.checkId) && check.kind.localId !== 'http' && check.kind.localId !== 'certificate') {
                                return unavailable('health_check_subject_unavailable');
                            }
                            const key = `${check.binding.targetLinkId}:${check.binding.domainId}`;
                            let domain = domains.get(key);
                            if (!domain) {
                                domain = readDomain(environment, check.binding.domainId, check.binding.targetLinkId, signal);
                                domains.set(key, domain);
                            }
                            const current = await domain;
                            if (contributions.has(check.checkId)) return { kind: 'contributed' as const, check };
                            if (!current.content.hostname) return unavailable('health_check_subject_unavailable');
                            const config = HealthCheckDomainHttpConfigV1Schema.safeParse(check.config);
                            if (!config.success) return unavailable('source_config_invalid');
                            return { kind: 'domain' as const, check, current, value: {
                                sourceInstanceId: request.sourceInstanceId, checkId: check.checkId, subject,
                                observer, vantage: deploymentDomainProbeVantageV1(
                                    environment.environment, current.targetLink, observer.machineId),
                                target: { kind: 'domain' as const, environmentId: subject.environmentId,
                                    targetLinkId: current.targetLink.id, domainId: current.domain.id,
                                    domainRevision: current.domain.revision, targetLinkRevision: current.targetLink.revision,
                                    hostname: current.content.hostname, healthCheck: current.content.healthCheck },
                                ...(config.data.keyword === undefined ? {} : { keyword: config.data.keyword }),
                            } satisfies AdmittedHttpHealthCheckV1 };
                        }));
                        const context = { signal, http: services.http, now: input.now ?? Date.now };
                        const results = await Promise.all(admitted.map(async item => item.kind === 'contributed'
                            ? readContributed(item.check) : item.kind === 'endpoint'
                            ? readSavedEndpointCheck(item.value, context, readHeartbeat)
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
                                domain: item.current.domain, observer, result: results[index]!.result,
                                tlsKind: item.current.content.tls?.kind, signal });
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
                    const admitted = checks.map(check => contributions.has(check.checkId)
                        ? { kind: 'contributed' as const, check }
                        : admitSavedEndpointCheck({ sourceInstanceId: request.sourceInstanceId, check, subject, observer, vantage }));
                    // Assignment/source edits are adopted at the next finite
                    // boundary. Cancellation remains live through the body.
                    const context = { signal, http: services.http, now: input.now ?? Date.now };
                    const results = await Promise.all(admitted.map(check => check.kind === 'contributed'
                        ? readContributed(check.check) : readSavedEndpointCheck(check, context, readHeartbeat)));
                    for (const observation of results) {
                        await input.onServiceResult?.({ serverId: input.serverId, sourceInstanceId: request.sourceInstanceId,
                            caller, occurrenceId: seed.occurrenceId, subject, generation: detail.service.generation,
                            check: checks.find(check => check.checkId === observation.checkId)!, result: observation.result,
                            retirementSignal: seed.retirementSignal });
                    }
                    return results;
                },
            });
        },
    });
}
