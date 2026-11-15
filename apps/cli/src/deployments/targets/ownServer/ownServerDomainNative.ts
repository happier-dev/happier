import { homedir } from 'node:os';
import {
    observeNativeCaddyContainer, connectNativeCaddyNetworks, createNativeCaddyAdminExchange, hashNativeCaddyPassword, checkNativeCaddyPortAvailability,
    type MachineSetupNativeCommand, type MachineSetupNativeCommandResult,
} from '@happier-dev/cli-common/machineSetup';
import {
    DeploymentDomainMachineTopologyV1Schema, deploymentDomainObservationProofPayloadV1,
    DeploymentDomainFailureDetailsV1Schema, DeploymentDomainCaddyFailureV1Schema,
    deploymentDomainFailureFactsV1, type DeploymentDomainFailureStepV1, type DeploymentDomainFailureDetailsV1,
    type DeploymentDomainObservationBodyV1,
} from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import type { ActionExecutorContext, DeploymentDomainChildRpcV1, DeploymentDomainDiscoverChildRpcV1 } from '@happier-dev/protocol';
import type { DeploymentDomainDnsChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { isDeploymentDomainAddActionIdV1, isDeploymentDomainRemoveActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readActionFailureCauseV1, projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentDomainArtifactV1, readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1, environmentSecretBindingIdentityV1,
    type DeploymentArtifactDocumentV1, type DeploymentEnvironmentDetailV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { ApiClient } from '@/api/api';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectNativeInvocationCustody } from '@/workspaces/projectSetup/projectSetupExecution';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeCaddyHostListeners } from '@/machines/reachability/nativeCaddyHostListeners';
import { readNativeCaddyDnsReadiness, nativeCaddyDnsResult } from '@/machines/reachability/nativeCaddyDnsReadiness';
import { createNativeCaddyRoutes } from '@/machines/reachability/nativeCaddyRoutes';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readDomainCaddyStartFirstLegs, selectDomainPublicCaddyServer, resolveDomainIngress, readDomainIngressMembersForHost, selectEdgeCaddyDomainRoute, selectPrivateCaddyOriginNetwork } from './domainRouteSelection';
import type { CaddyDomainRouteInput } from './caddyRouteMaterialization';
import { createNativeCaddyStartFirstRoutes } from '@/machines/reachability/nativeCaddyStartFirst';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentRuntime } from './ownServerDeploymentTarget';
import { readEnvironmentDomainSecretLaunchAdmissionForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { createCloudflareConnectorSetupSteps, createCloudflareConnectorRemovalSteps,
    ensureNativeCloudflareConnector, observeNativeCloudflareConnector, removeNativeCloudflareConnector,
    type MachineSetupApplyResultV1 } from '@happier-dev/cli-common/machineSetup';
import type { getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { runElevatedMachineSetupIntent,
    type MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { resolveMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import type { MachineConnectorSecretGrantHostRequest } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { projectDeploymentException } from '@/deployments/deploymentFailure';
import { logger } from '@/ui/logger';

/** Captured by the ApiMachine metadata owner, never a synthetic Machine RPC. */
export type DomainNativeSetupForHost = Readonly<{
    readDesired(): ReturnType<typeof getMachineSetupDesiredV1>;
    elevation: Pick<MachineElevationDependencies, 'readPolicy' | 'observe' | 'spawn' | 'prompt' | 'emit'>;
    settleCaddyFirewall?(input: Omit<Parameters<typeof import('@/machines/reachability/machineReachabilityHost').settleMachineCaddyFirewallForHost>[0],
        'port' | 'readDaemonProof'>): Promise<void>;
    settlePrivateWorkloadFirewall?(input: Omit<Parameters<typeof import('@/machines/reachability/machineReachabilityHost').settleMachinePrivateWorkloadFirewallForHost>[0],
        'port' | 'readDaemonProof'>): Promise<void>;
}>;

type DomainJob = DeploymentDomainChildRpcV1 | DeploymentDomainDiscoverChildRpcV1 | DeploymentDomainDnsChildRpcV1;
const refuse = (code: string, details?: unknown, failureCause?: ActionFailureCauseV1): never => {
    // A fresh, fixed-message stack names the producer even when it supplied no
    // typed diagnostics. Never log the thrown message, arguments or native output.
    logger.warnLocalFile('[Deployment] Domain native step refused', {
        phase: 'deployment.domain.native_execution', callSite: new Error('Domain native refusal').stack,
    });
    throw Object.assign(new Error(code), {
        code, ...(details === undefined ? {} : { details }), ...(failureCause ? { failureCause } : {}),
    });
};
const failure = (job: DomainJob, errorCode: string, details?: unknown, failureCause?: ActionFailureCauseV1) => {
    const parsed = DeploymentDomainFailureDetailsV1Schema.safeParse(details);
    const result = { ok: false as const, errorCode, error: errorCode,
        details: parsed.success && parsed.data.step !== 'native_execution' ? parsed.data : projectDeploymentFailureRecoveryV1({
            ...(parsed.success ? parsed.data : details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
            environmentId: job.input.environmentId, domainId: 'domainId' in job.input ? job.input.domainId : undefined, step: 'native_execution' as const,
        }),
        failureCause: failureCause ?? projectActionFailureCauseV1({ code: errorCode }, 'deployment.domain.native_execution') };
    // The file-log boundary projects only closed native facts, not arbitrary
    // remedies, provider output, exception codes or other private content.
    const native = DeploymentDomainCaddyFailureV1Schema.safeParse(result.details && 'failure' in result.details
        ? result.details.failure : undefined);
    logger.warnLocalFile('[Deployment] Domain native operation failed', {
        phase: 'deployment.domain.native_execution', kind: job.kind, actionId: job.actionId,
        environmentId: job.input.environmentId, domainId: 'domainId' in job.input ? job.input.domainId : undefined,
        ...(native.success ? { requiredFact: native.data.requiredFact, stepId: native.data.stepId,
            nativeCommand: native.data.nativeCommand, containerExitCode: native.data.containerExitCode,
            containerError: native.data.containerError, port: native.data.port } : {}),
    });
    return result;
};
const serviceUnavailable = (job: Exclude<DomainJob, DeploymentDomainDnsChildRpcV1>, step: DeploymentDomainFailureStepV1): never => refuse('service_unavailable', {
    environmentId: job.input.environmentId, domainId: job.input.domainId,
    step, requiredFact: deploymentDomainFailureFactsV1[step],
    remedy: 'Inspect the Environment Machine services, restore the unavailable service, then retry the Domain operation.',
} satisfies DeploymentDomainFailureDetailsV1, {
    phase: `deployment.domain.${step}`, errorClass: 'Error', errorCode: 'service_unavailable', httpStatus: null,
});

/** Deployment cutover consumes the same complete Domain inventory and native
 * Caddy writer as Domain activation. No replica/route inventory lives here. */
export function createOwnServerStartFirstRoutesForHost(host: Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    list: Parameters<typeof readDomainCaddyStartFirstLegs>[0]['list'];
}>): NonNullable<OwnServerDeploymentTargetHostInput['readStartFirstRoutes']> {
    return async (request, input) => {
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || identity.installationId !== input.installationId) return refuse('target_mismatch');
        const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
            const result = await input.docker.run(command.args, command.signal ?? input.signal, command.inputBytes);
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
        };
        // A positively empty Domain inventory needs no installed Caddy. Defer
        // its actual observation until the inventory owner encounters a leg.
        const observeCaddy = async () => {
            const machine = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => request.context.externalActionExecutionAuthorization
                ? ApiClient.getRequesterMachine(host.machineId, { authorization: request.context.externalActionExecutionAuthorization,
                    signal: input.signal, effectActionId: request.actionId })
                : ApiClient.create(host.credentials).then(api => api.getMachine(host.machineId, { signal: input.signal })));
            const caddy = await observeNativeCaddyContainer({ privateNetworks: machine?.daemonState?.reachability?.privateNetworks ?? [] },
                { run, signal: input.signal });
            if (caddy.status !== 'ready') return refuse(caddy.status === 'unavailable' ? caddy.reason : 'native_route_unavailable',
                caddy.status === 'unavailable' ? caddy.details : undefined);
            return caddy;
        };
        let observation: ReturnType<typeof observeCaddy> | undefined;
        const caddy = () => observation ??= observeCaddy();
        const routes = createNativeCaddyRoutes({ machineId: host.machineId, installationId: input.installationId,
            privateKey: decodeBase64(identity.privateKey, 'base64url'),
            exchange: async exchange => createNativeCaddyAdminExchange((await caddy()).adminSocketPath)(exchange) });
        const inventory = await readDomainCaddyStartFirstLegs({ serverId: host.serverId,
            environmentId: request.input.environmentId, targetLinkId: request.input.targetLinkId,
            machineId: host.machineId, installationId: input.installationId, dockerEngineId: input.docker.engineId,
            affectedServices: [...input.affectedServices], list: host.list,
            open: id => host.open(id, request.context), routes, signal: input.signal });
        if (inventory.kind !== 'ready') return refuse(inventory.reason);
        const adapter = createNativeCaddyStartFirstRoutes({ routes, legs: inventory.legs });
        return { switch: cutover => machineNativeEffectAdmission.runStage(input.context, async () => {
            if (inventory.legs.length) {
                const observed = await caddy();
                const affected = new Set(inventory.legs.map(leg => leg.route.domain.target.service));
                const connected = await connectNativeCaddyNetworks({ containerId: observed.containerId,
                    observedNetworkNames: observed.networkNames,
                    networkNames: cutover.candidate.services.filter(service => affected.has(service.service))
                        .flatMap(service => service.replicas.flatMap(replica => [...replica.networks])) },
                    { run, signal: cutover.signal ?? input.signal });
                if (connected.status !== 'ready') return { kind: 'unavailable' as const, reason: connected.reason, details: connected.details };
            }
            return adapter.switch(cutover);
        }) };
    };
}

/** Installed Domain work borrows P30's native transport and managed-service observations. */
export function createOwnServerDomainNative(host: Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    installedCredentials?: StoredCredentials;
    runtime?: Pick<OwnServerDeploymentRuntime, 'prepareDomainCaddy'>;
    captureNativeSetup?(): DomainNativeSetupForHost;
    ensureServiceObservations?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    open(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readReceipt: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readReceipt'];
}>) {
    async function acquire(job: DomainJob, context: ActionExecutorContext) {
        const signal = context.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || job.machineId !== host.machineId || job.installationId !== identity.installationId
            || job.input.serverId !== host.serverId) return refuse('target_mismatch');
        const opened = job.kind === 'domainDns' ? { ok: true as const, content: job.input.content } : await (async () => {
            const reference = job.kind === 'domain' ? job.capture.content : job.input;
            return readDeploymentDomainArtifactV1(reference, await host.open(reference.contentArtifactId, context));
        })();
        if (!opened.ok) return refuse(opened.error, undefined, opened.failureCause);
        const removing = job.kind === 'domain' ? !job.capture.desired : isDeploymentDomainRemoveActionIdV1(job.actionId);
        const observing = job.kind === 'domain' && job.actionId === 'deployments.domains.verify';
        const withoutWorkload = removing || observing || job.kind === 'domainDns';
        let environmentContent: DeploymentEnvironmentDetailV1['content'] | undefined;
        let members: Array<{ machineId: string; installationId: string; state: 'active' }> = [];
        if (job.kind === 'domainDiscover') {
            const environment = await host.readEnvironment({ environmentId: job.input.environmentId, context });
            const link = environment.targetLinks.find(item => item.targetLink.id === job.input.targetLinkId)?.targetLink;
            if (!link || link.targetKind !== 'ownServer') return refuse('target_mismatch');
            environmentContent = environment.content;
            members = (await readDomainIngressMembersForHost(link,
                'membershipMachines' in job.input ? job.input.membershipMachines : undefined, context, host.readReceipt)).map(member => ({
                machineId: member.machineId, installationId: member.installationId, state: 'active' }));
        } else if (job.kind === 'domain' && !withoutWorkload) {
            // Accepted work consumes its exact admitted private inputs, never a
            // fresh Source ACL, mutable head reference or target membership.
            const { environmentContent: environmentRef, targetLinkContent: linkRef } = job.capture;
            if (!environmentRef || !linkRef || !job.topology) return refuse('target_mismatch');
            const environment = readDeploymentEnvironmentArtifactV1(environmentRef, await host.open(environmentRef.contentArtifactId, context));
            if (!environment.ok) return refuse(environment.error, undefined, environment.failureCause);
            const link = readDeploymentTargetLinkArtifactV1(linkRef, await host.open(linkRef.contentArtifactId, context));
            if (!link.ok) return refuse(link.error, undefined, link.failureCause);
            environmentContent = environment.content;
            members = job.topology.members.map(member => ({ ...member, state: 'active' }));
        }
        if (environmentContent) {
            const resolved = resolveDomainIngress(opened.content, environmentContent.ingress);
            if (resolved.status === 'unavailable') return refuse(resolved.reason, resolved.details);
            environmentContent = { ...environmentContent, ingress: resolved.ingress };
        }
        const member = members.find(member => member.machineId === host.machineId && member.installationId === identity.installationId);
        if (!withoutWorkload && member) await host.ensureServiceObservations?.({
            environmentId: job.input.environmentId, composeService: opened.content.target.service,
        });
        const lease = withoutWorkload ? undefined
            : await (host.acquirePluginRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease)();
        const custody = createProjectNativeInvocationCustody({ signal });
        try {
            const service = !withoutWorkload && member ? lease!.registry.projectManagedServices.listProjectServices().find(service =>
                service.kind === 'environment' && service.environmentId === job.input.environmentId
                && service.composeService === opened.content.target.service && service.machineId === host.machineId) : undefined;
            let docker: ProjectNativeDockerPort;
            if (job.kind !== 'domainDns' && !withoutWorkload && member) {
                if (!service?.readNativeDocker) return serviceUnavailable(job, 'service_docker');
                docker = await service.readNativeDocker({ signal });
            } else {
                // The Machine setup owner selects Docker from this exact installed
                // host profile. The engine id is an admission key, never a URI.
                const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
                const io = createProjectNativeIo().environmentIo.createInvocation({ signal, retainCapture: custody.retain });
                const profile = { io, command: 'docker', prefix: [], cwd: homedir(), env, signal };
                const engine = await readNativeComposeEngine(profile);
                docker = { engineId: engine.id, engineKind: engine.kind, run: (args, nativeSignal, inputBytes) => io.run({ command: profile.command,
                    args, cwd: profile.cwd, env: profile.env, signal: nativeSignal ?? signal,
                    ...(inputBytes ? { stdin: inputBytes } : {}) }) };
            }
            if (presentMachineAuthorityV1({ engine: docker.engineKind }).deployment.domains === 'unavailableDockerDesktop') {
                return refuse('unsupported_platform');
            }
            if (job.kind === 'domain' && job.capture.dockerEngineId !== docker.engineId) return refuse('target_mismatch');
            const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
                const result = await docker.run(command.args, command.signal ?? signal, command.inputBytes);
                return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
            };
            const machine = withoutWorkload ? null : await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => context.externalActionExecutionAuthorization
                ? ApiClient.getRequesterMachine(host.machineId, { authorization: context.externalActionExecutionAuthorization, signal,
                    effectActionId: job.actionId })
                : (await ApiClient.create(host.credentials)).getMachine(host.machineId, { signal }));
            const privateNetworks = machine?.daemonState?.reachability?.privateNetworks ?? [];
            const observed = service?.readNativeContainers?.();
            const replicas = job.kind === 'domainDns' ? [] : observed?.filter(container => container.service === opened.content.target.service).map(container => {
                if (!container.containerName || !container.networkNames) return serviceUnavailable(job, 'container_identity');
                return { containerName: container.containerName, networkNames: [...container.networkNames] };
            }) ?? [];
            if (job.kind !== 'domainDns' && !withoutWorkload && member && !replicas.length) return serviceUnavailable(job, 'service_replicas');
            let caddy = await observeNativeCaddyContainer({ privateNetworks }, { run, signal });
            const retainedCaddy = caddy.status === 'ready' ? caddy : undefined;
            // Only an admitted Domain add prepares or reconciles infrastructure. Verify,
            // removal and deployment observations retain their read-only paths.
            if (job.kind === 'domainDiscover' && isDeploymentDomainAddActionIdV1(job.actionId) && member && environmentContent
                && (caddy.status === 'needs_setup' || caddy.status === 'stopped'
                    || caddy.status === 'unavailable' && caddy.reason === 'required_fact_unavailable'
                    || retainedCaddy && (retainedCaddy.containerOrigins?.length === 0
                        || replicas.some(replica => replica.networkNames.some(name => !retainedCaddy.networkNames.includes(name)))
                        || (!environmentContent.ingress
                            || environmentContent.ingress.kind === 'edgeCaddy' && environmentContent.ingress.edgeMachineId === host.machineId)
                        && !retainedCaddy.servers.some(server => server.tls && server.endpoints.length)))) {
                const setup = host.captureNativeSetup?.();
                if (!setup) return refuse('admin_access_unavailable');
                const admin = await setup.elevation.observe();
                const daemonGroupId = process.getgid?.();
                if (!admin.daemonPrimaryGroup || daemonGroupId === undefined) return refuse('required_fact_unavailable',
                    { requiredFact: admin.daemonPrimaryGroup ? 'daemonPrimaryGroupId' : 'daemonPrimaryGroup' });
                const prepared = host.runtime?.prepareDomainCaddy?.({ domain: opened.content, environment: environmentContent,
                    replicas, retainedCaddy, privateNetworks, daemonGroup: admin.daemonPrimaryGroup, daemonGroupId });
                if (!prepared) return refuse('native_route_unavailable');
                if (prepared.status !== 'ready') return refuse(prepared.reason, 'details' in prepared ? prepared.details : undefined);
                // The native binding owner observes conflicts before administrator
                // setup, firewall or Docker mutations. Apply consumes this once.
                const ports = await checkNativeCaddyPortAvailability(prepared.input, { run, signal, readLocalListeners: readNativeCaddyHostListeners });
                if (ports.status !== 'ready') return refuse(ports.reason, ports.details);
                const ready = await prepared.ensure({ setup, context, actionId: job.actionId,
                    installationId: identity.installationId, dockerEngineId: docker.engineId, run, signal });
                if (ready.status !== 'ready') return refuse('reason' in ready ? ready.reason : 'native_route_unavailable',
                    'details' in ready ? ready.details : undefined);
                caddy = await observeNativeCaddyContainer({ privateNetworks }, { run, signal });
            }
            if (caddy.status !== 'ready' && job.kind !== 'domainDns') return refuse(caddy.status === 'unavailable' ? caddy.reason : 'native_route_unavailable',
                caddy.status === 'unavailable' ? caddy.details : undefined);
            if (job.kind === 'domain' && caddy.status === 'ready' && !caddy.servers.some(server => server.serverId === job.capture.placement.nativeServer
                && (job.capture.listener === 'public' ? server.tls : !server.tls && server.automaticHttpsDisabled))) return refuse('target_mismatch');
            return { identity, signal, environmentContent, members, domain: opened.content, docker, run, caddy,
                get topology() { return DeploymentDomainMachineTopologyV1Schema.parse({ machineId: host.machineId,
                    installationId: identity.installationId, dockerEngineId: docker.engineId, privateNetworks, caddy, replicas }); },
                async release() { try { await custody.release(); } finally { custody.dispose(); await lease?.release(); } } };
        } catch (error) {
            try { await custody.release(); } finally { custody.dispose(); await lease?.release(); }
            throw error;
        }
    }
    async function discover(job: DeploymentDomainDiscoverChildRpcV1, context: ActionExecutorContext) {
        const acquired = await acquire(job, context);
        try { return acquired.topology; } finally { await acquired.release(); }
    }
    async function preview(job: DeploymentDomainDnsChildRpcV1, context: ActionExecutorContext) {
        const acquired = await acquire(job, context);
        try {
            const { identity, caddy, domain, signal } = acquired;
            const selection = selectDomainPublicCaddyServer({ machineId: host.machineId, caddy });
            if (selection.status !== 'ready' || caddy.status !== 'ready') {
                const basis = { observer: { machineId: host.machineId, installationId: identity.installationId },
                    vantage: 'sameMachine' as const, signal, startedAt: Date.now() };
                const health = await readNativeCaddyDnsReadiness(domain.hostname, basis, async () =>
                    nativeCaddyDnsResult(basis, 'unknown', 'dns_public_listener_unavailable'));
                return { ok: true as const, environmentId: job.input.environmentId,
                    dnsHealth: { status: health.status, evidence: health.evidence } };
            }
            const native = createNativeCaddyRoutes({ machineId: host.machineId, installationId: identity.installationId,
                privateKey: decodeBase64(identity.privateKey, 'base64url'),
                exchange: createNativeCaddyAdminExchange(caddy.adminSocketPath) });
            const health = await native.checkDnsReadiness({ hostname: domain.hostname,
                nativeServer: selection.nativeServer, listener: 'public', signal });
            if (!('status' in health)) return refuse('reason' in health ? health.reason : 'native_route_unavailable',
                'details' in health ? health.details : undefined, 'failureCause' in health ? health.failureCause : undefined);
            return { ok: true as const, environmentId: job.input.environmentId,
                dnsHealth: { status: health.status, evidence: health.evidence } };
        } finally { await acquired.release(); }
    }
    async function execute(job: DeploymentDomainChildRpcV1, context: ActionExecutorContext) {
        const acquired = await acquire(job, context);
        try {
            const { domain, topology, signal, identity } = acquired;
            const machines = job.topology?.machines ?? [topology];
            const members = acquired.members.map(member => ({ machineId: member.machineId, state: member.state,
                caddy: machines.find(machine => machine.machineId === member.machineId && machine.installationId === member.installationId)?.caddy
                    ?? { status: 'unavailable' as const, reason: 'required_fact_unavailable' as const } }));
            const native = createNativeCaddyRoutes({ machineId: host.machineId, installationId: identity.installationId,
                privateKey: decodeBase64(identity.privateKey, 'base64url'), exchange: createNativeCaddyAdminExchange(topology.caddy.adminSocketPath) });
            const basicAuth = domain.basicAuth ? [{ username: domain.basicAuth.username }] : undefined;
            const publicTls = domain.tls?.kind === 'custom' ? { kind: 'custom' as const } : { kind: 'managed' as const };
            const signObservation = (observation: DeploymentDomainObservationBodyV1) => ({ ...observation,
                proof: signMachineInstallationProof({ payload: deploymentDomainObservationProofPayloadV1({
                    expectedDomainRevision: job.expectedDomainRevision, observation }), privateKey: identity.privateKey }) });
            const routeIdentity = { domainId: job.input.domainId, domain, listener: job.capture.listener,
                ...(basicAuth ? { basicAuth } : {}), ...(job.capture.listener === 'public' ? { publicTls } : {}) };
            const readDnsHealth = async () => {
                const health = await native.checkDnsReadiness({ hostname: domain.hostname,
                    nativeServer: job.capture.placement.nativeServer, listener: job.capture.listener, signal });
                if (!('status' in health)) return refuse('reason' in health ? health.reason : 'native_route_unavailable',
                    'details' in health ? health.details : undefined, 'failureCause' in health ? health.failureCause : undefined);
                return { status: health.status, evidence: health.evidence };
            };
            const connector = job.cloudflareConnector;
            const settleConnector = async (remove: boolean) => {
                if (!connector) return;
                const operationId = job.actionOperationId;
                if (!operationId) return refuse('operation_unavailable');
                const setup = host.captureNativeSetup?.();
                if (!setup) return refuse('admin_access_unavailable');
                const desired = await setup.readDesired();
                if (desired.status !== 'ready') return refuse('required_fact_unavailable', { requiredFact: 'machineSetupDesired' });
                const assertCurrent = async () => { signal.throwIfAborted(); };
                const grant: MachineConnectorSecretGrantHostRequest = {
                    credentials: host.installedCredentials ?? host.credentials, serverId: job.input.serverId,
                    serverHttpBaseUrl: host.serverHttpBaseUrl, hostMachineId: host.machineId,
                    hostInstallationId: identity.installationId, signal, assertCurrent,
                    context: { ...context, operationAcceptance: { operationId } },
                    subject: { v: 1, kind: 'connectorToken', machineId: job.machineId,
                        installationId: job.installationId, provider: { kind: 'builtin', id: 'cloudflareNamed' },
                        connectorId: connector.tunnelId },
                };
                if (remove) {
                    const removed = await removeNativeCloudflareConnector(connector, { run: acquired.run, signal });
                    if (removed.status !== 'removed') return refuse(removed.reason, 'details' in removed ? removed.details : undefined);
                }
                let applied: MachineSetupApplyResultV1 | undefined;
                const elevated = await runElevatedMachineSetupIntent({ machineId: host.machineId,
                    operationId, signal,
                    basis: { kind: 'setup', machineId: host.machineId, desiredRevision: desired.policy.revision },
                    steps: remove ? createCloudflareConnectorRemovalSteps(connector) : createCloudflareConnectorSetupSteps(connector),
                    onSetupApplied(result) { applied = result; },
                }, { ...setup.elevation, installationId: identity.installationId,
                    ...resolveMachineEffectCli(), verifyCurrent: async () => !signal.aborted,
                    connectorSecretGrant: grant });
                if (elevated.outcome !== 'applied') return refuse('reasonCode' in elevated ? elevated.reasonCode : elevated.outcome,
                    'failure' in elevated && elevated.failure ? { failure: elevated.failure,
                        ...(elevated.failure.remedy ? { remedy: elevated.failure.remedy } : {}) } : undefined);
                if (!applied) return refuse('outcome_unknown');
                if (!remove) {
                    const ready = await ensureNativeCloudflareConnector(connector, { run: acquired.run, signal, setupResult: applied });
                    if (ready.status !== 'ready') return refuse('reason' in ready ? ready.reason : 'native_effect_failed',
                        'details' in ready ? ready.details : undefined);
                }
            };
            if (job.actionId === 'deployments.domains.verify') {
                if (connector) {
                    const ready = await observeNativeCloudflareConnector(connector, { run: acquired.run, signal });
                    if (ready.status !== 'ready') return failure(job, 'reason' in ready ? ready.reason : 'native_effect_failed',
                        'details' in ready ? ready.details : undefined);
                }
                const networkExposure = await native.readExposure({ placement: job.capture.placement,
                    route: routeIdentity, caddy: topology.caddy, signal });
                if (networkExposure.kind !== 'ready') return failure(job, networkExposure.reason,
                    networkExposure.details ?? { requiredFact: networkExposure.requiredFact, remedy: networkExposure.remedy },
                    networkExposure.failureCause);
                return signObservation({ capture: job.capture, state: 'active', networkExposure,
                    dnsHealth: await readDnsHealth() });
            }
            if (!job.capture.desired) {
                // The parent already selected last-consumer retirement. With no
                // private operand, retain the connector shared by other Domains.
                const removal = await machineNativeEffectAdmission.run({ operation: {
                    operationId: job.actionOperationId!, kind: job.actionId, signal },
                    keys: [{ kind: 'dockerEngine', dockerEndpoint: acquired.docker.engineId }] }, nativeContext =>
                    machineNativeEffectAdmission.runStage(nativeContext, async () => {
                        await settleConnector(true);
                        return native.remove({ placement: job.capture.placement, route: routeIdentity, signal });
                    }));
                if (removal.kind !== 'removed') return failure(job, 'reason' in removal ? removal.reason : 'native_route_unavailable',
                    'details' in removal ? removal.details : undefined, 'failureCause' in removal ? removal.failureCause : undefined);
                return signObservation({ capture: job.capture, state: 'removed', removal });
            }
            const environmentContent = acquired.environmentContent;
            if (!environmentContent) return refuse('target_mismatch');
            if (environmentContent.ingress?.kind === 'cloudflareTunnel' && !connector) return refuse('required_fact_unavailable',
                { requiredFact: 'cloudflareConnector' });
            let route: CaddyDomainRouteInput;
            let routeState: 'active' | 'warning' = 'active';
            const ingress = environmentContent.ingress;
            if (ingress?.kind === 'edgeCaddy' && ingress.edgeMachineId === host.machineId && job.capture.listener === 'public') {
                const selected = selectEdgeCaddyDomainRoute({ ingress, domainId: job.input.domainId, domain,
                    edge: { machineId: host.machineId, caddy: topology.caddy, privateNetworks: topology.privateNetworks }, members,
                    ...(basicAuth ? { basicAuth } : {}), publicTls });
                if (selected.status !== 'ready') return refuse(selected.reason, 'details' in selected ? selected.details : undefined);
                route = selected.route;
            } else {
                const selected = selectPrivateCaddyOriginNetwork({ observerNetworks: topology.privateNetworks, members });
                if (selected.status !== 'ready' && members.filter(member => member.state === 'active').length > 1) routeState = 'warning';
                const peers = selected.status === 'ready' ? selected.origins.filter(origin => origin.machineId !== host.machineId).flatMap(origin => origin.endpoints) : [];
                const names = topology.replicas.map(replica => replica.containerName);
                if (!names[0]) return serviceUnavailable(job, 'route_upstreams');
                route = { domainId: job.input.domainId, domain, listener: job.capture.listener,
                    upstreams: { kind: 'replicas', containerNames: [names[0], ...names.slice(1)] },
                    privateSourceRanges: selected.status === 'ready' ? selected.sourceRanges : [],
                    ...(peers.length ? { peerOrigins: peers } : {}), ...(basicAuth ? { basicAuth } : {}),
                    ...(job.capture.listener === 'public' ? { publicTls } : {}) };
            }
            const request = { placement: job.capture.placement, route, signal };
            const effect = async () => {
                const readCredential = async (role: Extract<EnvironmentSecretBindingV1, { purpose: 'domainCredential' }>['role']) => {
                    const use = environmentContent.bindings.find((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'domainCredential' }> =>
                        binding.purpose === 'domainCredential' && binding.domainId === job.input.domainId && binding.role === role);
                    if (!use) return refuse('secret_missing');
                    const admission = await readEnvironmentDomainSecretLaunchAdmissionForHost({
                        credentials: host.installedCredentials ?? host.credentials, serverId: host.serverId,
                        serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId, installationId: identity.installationId,
                        environmentId: job.input.environmentId, targetLinkId: job.capture.placement.targetLinkId,
                        context, signal, materialization: { kind: 'domain', domainId: job.input.domainId,
                            expectedDomainRevision: job.expectedDomainRevision, actionOperationId: job.actionOperationId!, capture: job.capture, use } });
                    const seed = decodeBase64(identity.privateKey, 'base64url').slice(0, 32);
                    let material: Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>> | undefined;
                    try {
                        material = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: job.input.environmentId,
                            machineId: host.machineId, installationId: identity.installationId, installationPrivateSeed: seed,
                            use, bindings: environmentContent.bindings, grants: admission.grants,
                            assertCurrent: admission.assertCurrent });
                        return material.operationalValues.get(environmentSecretBindingIdentityV1(use)) ?? refuse('secret_missing');
                    } finally { seed.fill(0); material?.dispose(); await admission.release?.(); }
                };
                if (domain.basicAuth) {
                    const password = await readCredential('basicAuth');
                    const hashed = await hashNativeCaddyPassword({ containerId: topology.caddy.containerId, password }, { run: acquired.run, signal });
                    if (hashed.status !== 'ready') return refuse(hashed.reason);
                    route.basicAuth = [{ username: domain.basicAuth.username, bcryptHash: hashed.bcryptHash }];
                }
                if (job.capture.listener === 'public' && domain.tls?.kind === 'custom') {
                    const certificatePem = await readCredential('certificateChain');
                    const privateKeyPem = await readCredential('privateKey');
                    route.publicTls = { kind: 'custom', certificatePem, privateKeyPem };
                }
                const connected = await connectNativeCaddyNetworks({ containerId: topology.caddy.containerId,
                    observedNetworkNames: topology.caddy.networkNames,
                    networkNames: [...new Set(topology.replicas.flatMap(replica => replica.networkNames))] }, { run: acquired.run, signal });
                if (connected.status !== 'ready') return refuse(connected.reason, connected.details);
                const activated = await native.activate({ ...request, captureExposure: topology.caddy });
                if (activated.kind === 'active') await settleConnector(false);
                return activated;
            };
            const result = await machineNativeEffectAdmission.run({ operation: { operationId: job.actionOperationId!, kind: job.actionId, signal },
                    keys: [{ kind: 'dockerEngine', dockerEndpoint: acquired.docker.engineId }] }, native => machineNativeEffectAdmission.runStage(native, effect));
            if (result.kind !== 'active') return failure(job, 'reason' in result ? result.reason : 'native_route_unavailable',
                'details' in result ? result.details : undefined, 'failureCause' in result ? result.failureCause : undefined);
            const observation: DeploymentDomainObservationBodyV1 = { capture: job.capture,
                state: routeState,
                ...(result.networkExposure ? { networkExposure: result.networkExposure } : {}),
                // Materialization owns localOrigin: redirects and edge-to-origin
                // proxies do not configure local replicas, even if discovered.
                ...(result.networkExposure?.kind === 'ready' ? { routedReplicas:
                    result.networkExposure.localOrigin && route.upstreams.kind === 'replicas'
                        ? route.upstreams.containerNames.map(containerName => ({ containerName })) : [] } : {}) };
            return signObservation(observation);
        } finally { await acquired.release(); }
    }
    return async (job: DomainJob, context: ActionExecutorContext) => {
        try { return job.kind === 'domainDns' ? await preview(job, context)
            : job.kind === 'domainDiscover' ? await discover(job, context) : await execute(job, context); }
        catch (error) {
            const projected = projectDeploymentException(error, { signal: context.signal, phase: 'deployment.domain.native_execution' });
            const failureCause = error instanceof Error && 'failureCause' in error && error.failureCause !== undefined
                ? readActionFailureCauseV1(error.failureCause) : undefined;
            return { ...failure(job, projected.errorCode,
                (error instanceof Error && 'details' in error ? error.details : undefined) ?? projected.details,
                failureCause ?? projected.failureCause), error: projected.error,
                ...(typeof projected.effectAttempted === 'boolean' ? { effectAttempted: projected.effectAttempted } : {}) }; }
    };
}
