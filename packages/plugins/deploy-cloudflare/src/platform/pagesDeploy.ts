import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  PluginError, type DeploymentTargetDeployInputV1, type DeploymentTargetRoleFailureV1,
  type DeploymentTargetRoleResultV1, type DeploymentTargetObserveInputV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { failure, request, type DeploymentContext } from './deploymentHttp.js';
import { observePagesDeployment, pagesDeploymentResult } from './pages.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';

export function pagesResult(value: DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1): DeploymentTargetRoleResultV1 {
  if ('code' in value) throw withActionFailureDiagnostic(new PluginError({ code: value.code, retryable: value.retryable, details: { phase: value.phase },
    failureCause: projectActionFailureCauseV1(value, `deployment.cloudflare.${value.phase}`) }),
    { phase: `deployment.cloudflare.${value.phase}`, causeKind: 'native_failure', error: value });
  return value;
}

/** The captured production branch or explicit Preview branch decides the native Pages environment. */
export function pagesBranch(input: Pick<DeploymentTargetDeployInputV1, 'providerEnvironment' | 'preparedNative'>): string | null {
  const pages = input.preparedNative?.pages;
  if (!pages) return null;
  if (input.providerEnvironment.kind === 'production') return pages.productionBranch;
  if (input.providerEnvironment.kind === 'preview' && !('scriptName' in input.providerEnvironment)
    && input.providerEnvironment.gitBranch && input.providerEnvironment.gitBranch !== pages.productionBranch) return input.providerEnvironment.gitBranch;
  return null;
}

export async function createPagesDeployment(input: DeploymentTargetDeployInputV1 | import('@happier-dev/plugin-sdk').DeploymentTargetUploadDeployInputV1,
  form: FormData, context: DeploymentContext): Promise<DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1> {
  const branch = pagesBranch(input);
  if (!branch || input.sourceIntent.kind !== 'repository') return failure('unsupported_action', 'admission');
  form.set('branch', branch);
  // Git builds branch HEAD; commit_hash only labels the deployment. Uploads
  // contain the exact reviewed checkout and can truthfully carry that label.
  if (input.sourceMethod === 'upload') {
    form.set('commit_hash', input.sourceIntent.sha);
    form.set('commit_dirty', 'false');
  }
  const encoded = new Response(form);
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/pages/projects/${encodeURIComponent(input.preparedNative!.projectName)}/deployments`, 'send', ['write', 'POST'],
    new Uint8Array(await encoded.arrayBuffer()), encoded.headers.get('content-type')!);
  if ('code' in reply) return reply;
  if (!isObject(reply.value) || typeof reply.value.id !== 'string') return failure('outcome_unknown', 'send');
  const result = pagesDeploymentResult(reply.value, { ...input, providerDeploymentId: reply.value.id }, context, 'send');
  return 'code' in result ? { v: 1, state: 'outcome_unknown', providerDeploymentId: reply.value.id, observedAtMs: context.now() } : result;
}

export const pagesLifecycleActions = {
  'pages-deploy': { ...pagesCommon, title: 'Deploy the Cloudflare Pages Git branch', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Deploy the latest commit on this Cloudflare Pages branch?' }, inputSchema: inputs.deploy.jsonSchema, resultSchema: output.jsonSchema,
    async run(value: JsonValue, context: PluginAccountActionContext) {
      const input = value as unknown as DeploymentTargetDeployInputV1, io = pagesIo(context);
      if (input.providerDeploymentId) return pagesResult(await observePagesDeployment(input, io));
      if (input.preparedNative?.pages?.projectMode !== 'gitIntegration') {
        throw new PluginError({ code: 'unsupported_action', details: { phase: 'source' } });
      }
      return pagesResult(await createPagesDeployment(input, new FormData(), io));
    } },
  'pages-observe': { ...pagesCommon, title: 'Observe the selected Cloudflare Pages deployment', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs.observe.jsonSchema, resultSchema: output.jsonSchema,
    async run(value: JsonValue, context: PluginAccountActionContext) {
      return pagesResult(await observePagesDeployment(value as unknown as DeploymentTargetObserveInputV1, pagesIo(context)));
    } },
} as const;
