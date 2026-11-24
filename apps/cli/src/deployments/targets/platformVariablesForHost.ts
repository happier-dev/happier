import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTargetRoleInputSchemasV1, DeploymentTargetVariablesReadResultV1Schema,
    DeploymentTargetVariablesSyncResultV1Schema, type DeploymentTargetVariablesSyncInputV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { DeploymentObservationGetResultV1Schema,
    DeploymentObservationGetInputV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1, usesOwnTelemetryCollectorV1 } from '@happier-dev/deployments/telemetry';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { createContributedDeploymentTargetForHost } from './contributedDeploymentTargetForHost';
import type { PreparePlatformBindingsForHost } from '../secrets/prepareDeploymentBindingsForHost';

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
type Host = Readonly<{
    withTargetRole: ReturnType<typeof createContributedDeploymentTargetForHost>['withTargetRole'];
    readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
}>;

/** Variables spend the existing reviewed Action child and same Environment/Link custody. */
export function createPlatformVariablesForHost(host: Host) {
    const sync: PreparePlatformBindingsForHost = async request => {
        const environment: DeploymentEnvironmentDetailV1 = { environment: request.environment.environment,
            content: request.previousContent, targetLinks: request.environment.targetLinks.map(targetLink => ({ targetLink,
                ...(targetLink.id === request.targetLink.id ? { content: request.linkContent } : {}) })) };
        return host.withTargetRole({ environmentId: environment.environment.id, targetLinkId: request.targetLink.id,
            context: request.context }, environment, 'variables.sync', async scope => {
                const child = request.context.hostReviewedChild ?? refuse('action_forbidden');
                const keepTheirs = new Set('providerVariables' in request.input ? request.input.providerVariables?.keepTheirs ?? [] : []);
                const ownCollector = usesOwnTelemetryCollectorV1(keepTheirs);
                const previousManaged = new Set(request.previousContent.bindings.filter(binding => binding.purpose === 'variable'
                    && binding.managedBy === 'telemetry').map(binding => binding.name));
                const worker = request.targetLink.targetKind === 'cloudflare-workers';
                const ownedDestinations = request.linkContent.ownedTelemetryDestinations ?? [];
                const selectedCollector = request.input.telemetryMachineId;
                const exporterHeader = request.content.bindings.find(binding => binding.purpose === 'variable'
                    && binding.managedBy === 'telemetry' && binding.name === 'OTEL_EXPORTER_OTLP_HEADERS'
                    && binding.valueFormat === 'otelAuthorizationHeader');
                const acknowledge = async () => selectedCollector && exporterHeader?.source.kind === 'secret'
                    && request.acknowledgeTelemetryBearer ? {
                        telemetryMachineId: selectedCollector,
                        telemetryTokenHash: await request.acknowledgeTelemetryBearer(exporterHeader.source),
                    } : undefined;
                let telemetryDestination: DeploymentTargetVariablesSyncInputV1['telemetryDestination'];
                let bearer: Extract<NonNullable<DeploymentTargetVariablesSyncInputV1['telemetryDestination']>,
                    { decision: 'activate' }>['bearer'] | undefined;
                if (worker && 'telemetryMachineId' in request.input && request.input.telemetryMachineId !== undefined) {
                    if (request.input.telemetryMachineId === null) {
                        telemetryDestination = { decision: 'remove', owned: ownedDestinations };
                    } else {
                        // The reviewed telemetry parent already admitted the exact public collector Domain.
                        const endpoint = request.content.bindings.find(binding => binding.purpose === 'variable'
                            && binding.managedBy === 'telemetry' && binding.name === 'OTEL_EXPORTER_OTLP_ENDPOINT');
                        if (endpoint?.source.kind !== 'value' || exporterHeader?.source.kind !== 'secret')
                            return refuse('deployment_content_unavailable');
                        telemetryDestination = { decision: 'allocate', collectorUrl: endpoint.source.value, owned: ownedDestinations };
                        bearer = exporterHeader.source;
                    }
                }
                const set = request.content.bindings.filter(binding => {
                    if (binding.purpose !== 'variable') return false;
                    if (worker && (telemetryDestination || ownedDestinations.length > 0) && binding.managedBy === 'telemetry'
                        && TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1.some(name => name === binding.name)) return false;
                    if (!ownCollector || binding.managedBy !== 'telemetry') return true;
                    // An existing caller-authored header remains theirs; only a
                    // previously managed value may be removed with its provenance.
                    if (!previousManaged.has(binding.name)) keepTheirs.add(binding.name);
                    return false;
                });
                const input = DeploymentTargetRoleInputSchemasV1['variables.sync'].parse({ ...scope.common,
                    owned: request.linkContent.ownedVariables ?? [], desiredRevision: request.input.expectedRevision + 1, set,
                    remove: (request.linkContent.ownedVariables ?? []).filter(owned => !set.some(binding => binding.name === owned.key)).map(owned => owned.key),
                    useOurs: 'providerVariables' in request.input ? request.input.providerVariables?.useOurs ?? [] : [],
                    keepTheirs: [...keepTheirs], ...(telemetryDestination ? { telemetryDestination } : {}) });
                await scope.admit(input, 'preparation');
                const invoke = async (syncInput: DeploymentTargetVariablesSyncInputV1) => {
                    const invoked = await child.invoke({ action: scope.action, role: 'variables.sync',
                        input: normalizeStrictJsonValue(syncInput) });
                    if (!invoked.ok) throw createActionExecuteFailureError(invoked);
                    return DeploymentTargetVariablesSyncResultV1Schema.parse(invoked.result);
                };
                const result = await invoke(input);
                const destination = result.telemetryDestination;
                const providerVariables = { v: 1 as const, variables: result.variables, failures: result.failures, persisted: false,
                    ...(destination ? { telemetryDestination: destination } : {}) };
                const vercelExporterAcknowledged = request.targetLink.targetKind === 'vercel' && !ownCollector
                    && ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'].every(key =>
                        set.some(binding => binding.purpose === 'variable' && binding.name === key && binding.managedBy === 'telemetry')
                        && result.owned.some(owned => owned.key === key && owned.desiredRevision === input.desiredRevision)
                        && !result.failures.some(failure => failure.key === key));
                const telemetrySyncAcknowledgement = vercelExporterAcknowledged ? await acknowledge() : undefined;
                const allocation = input.telemetryDestination;
                const afterCommit = allocation?.decision === 'allocate' && bearer && destination?.owned.length
                    ? { collectorUrl: allocation.collectorUrl, bearer, owned: destination.owned }
                    : undefined;
                return { linkContent: { ...request.linkContent, ownedVariables: result.owned,
                    ...(destination ? { ownedTelemetryDestinations: destination.owned } : {}) }, providerVariables,
                    ...(telemetrySyncAcknowledgement ? { telemetrySyncAcknowledgement } : {}),
                    ...(afterCommit && destination ? { async completeProviderVariables() {
                        const activated = await invoke({ ...input, owned: result.owned, set: [], remove: [], useOurs: [], keepTheirs: [],
                            telemetryDestination: { decision: 'activate', ...afterCommit } });
                        if (!activated.telemetryDestination) return refuse('deployment_content_unavailable');
                        const failures = [...destination.failures, ...activated.telemetryDestination.failures];
                        const configured = activated.telemetryDestination.configured;
                        const activatedAcknowledgement = failures.length === 0 && (['traces', 'logs'] as const).every(type =>
                            configured.some(row => row.type === type)) ? await acknowledge() : undefined;
                        return { providerVariables: { ...providerVariables, telemetryDestination: {
                            owned: destination.owned, configured, failures,
                        } }, ...(activatedAcknowledgement ? { telemetrySyncAcknowledgement: activatedAcknowledgement } : {}) };
                    } } : {}) };
            });
    };
    async function prepareRead(request: Readonly<{ input: ReturnType<typeof DeploymentObservationGetInputV1Schema.parse>; context: ActionExecutorContext }>) {
        if (request.input.variables !== true) return null;
        if (request.input.deploymentId !== undefined) return refuse('deployment_invalid');
        const environment = await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
        const row = environment.targetLinks.find(row => row.targetLink.id === request.input.targetLinkId);
        if (!row) return refuse('target_mismatch');
        if (row.targetLink.source.kind !== 'plugin') return refuse('unsupported_action');
        return host.withTargetRole({ environmentId: environment.environment.id, targetLinkId: row.targetLink.id,
            context: request.context }, environment, 'variables.read', async scope => {
                const input = DeploymentTargetRoleInputSchemasV1['variables.read'].parse({ ...scope.common,
                    owned: row.content?.ownedVariables ?? [] });
                await scope.admit(input, 'execution');
                return { children: [{ action: scope.action, role: 'variables.read', input: normalizeStrictJsonValue(input) }],
                    executeAdmittedAction: async ({ context }: Readonly<{ context: ActionExecutorContext }>) => {
                        if (!context.hostReviewedChild) return refuse('action_forbidden');
                        const invoked = await context.hostReviewedChild.invoke({ action: scope.action, role: 'variables.read',
                            input: normalizeStrictJsonValue(input) });
                        if (!invoked.ok) return invoked;
                        return { ok: true as const, result: normalizeStrictJsonValue(DeploymentObservationGetResultV1Schema.parse({
                            ok: true, environment: environment.environment, targetLink: row.targetLink,
                            credentialPrincipal: row.content?.credentialPrincipal,
                            providerVariables: DeploymentTargetVariablesReadResultV1Schema.parse(invoked.result) })) };
                    } };
            });
    }
    return { sync, prepareRead };
}
