import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTargetRoleInputSchemasV1, DeploymentTargetVariablesReadResultV1Schema,
    DeploymentTargetVariablesSyncResultV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { DeploymentObservationGetResultV1Schema, type DeploymentBindingsSetInputV1,
    DeploymentObservationGetInputV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { createContributedDeploymentTargetForHost } from './contributedDeploymentTargetForHost';
import type { PreparePlatformBindingsForHost } from '../secrets/prepareDeploymentBindingsForHost';

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
type Host = Readonly<{
    withTargetRole: ReturnType<typeof createContributedDeploymentTargetForHost>['withTargetRole'];
    readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
}>;

/** Variables spend the existing reviewed Action child and same Environment/Link custody. */
export function createPlatformVariablesForHost(host: Host) {
    const runtime = (environment: DeploymentEnvironmentDetailV1) => environment.targetLinks.find(row =>
        row.targetLink.id === environment.environment.runtimeTargetLinkId && row.targetLink.source.kind === 'plugin');
    async function prepareBindingsChildren(request: Readonly<{ input: DeploymentBindingsSetInputV1; context: ActionExecutorContext }>) {
        const environment = await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
        const row = runtime(environment);
        if (!row) return null;
        return host.withTargetRole({ environmentId: environment.environment.id, targetLinkId: row.targetLink.id,
            context: request.context }, environment, 'variables.sync', async scope => {
                return { children: scope.children };
            });
    }
    const sync: PreparePlatformBindingsForHost = async request => {
        const environment: DeploymentEnvironmentDetailV1 = { environment: request.environment.environment,
            content: request.previousContent, targetLinks: request.environment.targetLinks.map(targetLink => ({ targetLink,
                ...(targetLink.id === request.targetLink.id ? { content: request.linkContent } : {}) })) };
        return host.withTargetRole({ environmentId: environment.environment.id, targetLinkId: request.targetLink.id,
            context: request.context }, environment, 'variables.sync', async scope => {
                if (!request.context.hostReviewedChild) return refuse('action_forbidden');
                const set = request.content.bindings.filter(binding => binding.purpose === 'variable');
                const input = DeploymentTargetRoleInputSchemasV1['variables.sync'].parse({ ...scope.common,
                    owned: request.linkContent.ownedVariables ?? [], desiredRevision: request.input.expectedRevision + 1, set,
                    remove: (request.linkContent.ownedVariables ?? []).filter(owned => !set.some(binding => binding.name === owned.key)).map(owned => owned.key),
                    useOurs: 'providerVariables' in request.input ? request.input.providerVariables?.useOurs ?? [] : [],
                    keepTheirs: 'providerVariables' in request.input ? request.input.providerVariables?.keepTheirs ?? [] : [] });
                await scope.admit(input, 'preparation');
                const invoked = await request.context.hostReviewedChild.invoke({ action: scope.action, role: 'variables.sync',
                    input: normalizeStrictJsonValue(input) });
                if (!invoked.ok) throw createActionExecuteFailureError({ ok: false, errorCode: invoked.errorCode, error: invoked.errorCode });
                const result = DeploymentTargetVariablesSyncResultV1Schema.parse(invoked.result);
                return { linkContent: { ...request.linkContent, ownedVariables: result.owned },
                    providerVariables: { v: 1, variables: result.variables, failures: result.failures, persisted: false } };
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
    return { prepareBindingsChildren, sync, prepareRead };
}
