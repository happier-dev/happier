import { vercelRoleSchema, type VercelRoleInput } from './selection.js';
import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  PluginError, type DeploymentTargetDeployInputV1, type DeploymentTargetObserveInputV1, type DeploymentTargetCancelInputV1, type DeploymentTargetRollbackInputV1, type DeploymentTargetTeardownInputV1, type DeploymentTargetRoleResultV1,
  type DeploymentTargetRoleFailureV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { cancelVercelDeployment, deployVercelCommit, observeVercelDeployment } from './operations.js';
import { changeVercelTraffic, observeVercelTraffic } from './traffic.js';
import { observeVercelTeardown, teardownVercelProject } from './teardown.js';

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  resultSchema: output.jsonSchema } as const;
function context(context: PluginAccountActionContext) {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  return { http: context.services.http, signal: context.signal, now: () => Date.now() };
}
function result(outcome: DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1) {
  if ('code' in outcome) throw withActionFailureDiagnostic(new PluginError({ code: outcome.code, retryable: outcome.retryable, details: { phase: outcome.phase },
    failureCause: projectActionFailureCauseV1(outcome, `deployment.vercel.${outcome.phase}`) }),
    { phase: `deployment.vercel.${outcome.phase}`, causeKind: 'native_failure', error: outcome });
  return outcome;
}
type DeployInput = VercelRoleInput<DeploymentTargetDeployInputV1>;

async function deploy(input: DeployInput, ctx: PluginAccountActionContext) {
  const io = context(ctx);
  if (input.providerDeploymentId) return result(await observeVercelDeployment(input, io));
  if (!input.preparedNative) throw new PluginError({ code: 'deployment_content_unavailable' });
  // Repository access is the commit producer's decision: a link without it settles as needsGitAccess.
  return result(await deployVercelCommit({ providerIdentity: input.providerIdentity,
    providerEnvironment: input.providerEnvironment,
    ...(input.repositoryAccess ? { repositoryAccess: input.repositoryAccess } : {}),
    ...input.preparedNative, sourceIntent: input.sourceIntent }, io));
}
export const lifecycleActions = {
  deploy: { ...common, title: 'Deploy the reviewed Vercel commit', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Deploy this reviewed commit to Vercel?' },
    inputSchema: vercelRoleSchema(inputs.deploy.jsonSchema),
    // Ordinary Action admission already validated this exact canonical schema.
    run: (input: JsonValue, ctx: PluginAccountActionContext) => deploy(input as unknown as DeployInput, ctx) },
  observe: { ...common, title: 'Observe the selected Vercel deployment', dangerLevel: 'safe', readOnly: true,
    inputSchema: vercelRoleSchema(inputs.observe.jsonSchema),
    run: async (input: JsonValue, ctx: PluginAccountActionContext) => {
      const selection = input as unknown as DeploymentTargetObserveInputV1;
      if (selection.operation === 'teardown') return observeVercelTeardown(selection, context(ctx));
      return selection.operation === 'promote' || selection.operation === 'rollback'
        ? observeVercelTraffic(selection, selection.operation, context(ctx))
        : result(await observeVercelDeployment(selection, context(ctx)));
    } },
  promote: { ...common, title: 'Promote the selected Vercel deployment', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Send production traffic to this Vercel deployment?' }, inputSchema: vercelRoleSchema(inputs.promote.jsonSchema),
    run: async (input: JsonValue, ctx: PluginAccountActionContext) => result(await changeVercelTraffic(input as unknown as VercelRoleInput<DeploymentTargetRollbackInputV1>, 'promote', context(ctx))) },
  rollback: { ...common, title: 'Restore the selected Vercel deployment', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Restore production traffic to this Vercel deployment?' }, inputSchema: vercelRoleSchema(inputs.rollback.jsonSchema),
    run: async (input: JsonValue, ctx: PluginAccountActionContext) => result(await changeVercelTraffic(input as unknown as VercelRoleInput<DeploymentTargetRollbackInputV1>, 'rollback', context(ctx))) },
  teardown: { ...common, title: 'Delete the selected Vercel project', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Delete this Vercel project and its deployments?' }, inputSchema: vercelRoleSchema(inputs.teardown.jsonSchema),
    run: (input: JsonValue, ctx: PluginAccountActionContext) => teardownVercelProject(input as unknown as DeploymentTargetTeardownInputV1, context(ctx)) },
  cancel: { ...common, title: 'Cancel the selected Vercel deployment', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Cancel this Vercel deployment?' },
    inputSchema: vercelRoleSchema(inputs.cancel.jsonSchema),
    run: async (input: JsonValue, ctx: PluginAccountActionContext) => result(await cancelVercelDeployment(input as unknown as DeploymentTargetCancelInputV1, context(ctx))) },
} as const;
