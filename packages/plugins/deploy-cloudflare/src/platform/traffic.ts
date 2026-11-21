import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  type DeploymentTargetRollbackInputV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { failure, request } from './deploymentHttp.js';
import { pagesDeploymentResult } from './pages.js';
import { pagesResult } from './pagesDeploy.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';
import { cloudflareRoleSchema, type CloudflareRoleInput, type PagesSelection } from './targetSelection.js';

/** Pages rollback restores an existing production deployment; Preview promotion is not a Pages API operation.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/
 * Contract inspected 2026-11-10. A lost write response is retained as unknown, never repeated.
 */
export const pagesTrafficActions = {
  'pages-rollback': { ...pagesCommon, title: 'Restore the selected Cloudflare Pages deployment',
    dangerLevel: 'writesRemote', readOnly: false, confirmation: { title: 'Restore this Cloudflare Pages deployment?' },
    inputSchema: cloudflareRoleSchema(inputs.rollback.jsonSchema, 'pages'), resultSchema: output.jsonSchema,
    async run(raw: JsonValue, context: PluginAccountActionContext) {
      const input = raw as unknown as CloudflareRoleInput<DeploymentTargetRollbackInputV1, PagesSelection>;
      if (input.providerEnvironment.selection.kind !== 'production') return pagesResult(failure('unsupported_action', 'admission'));
      if (!input.preparedNative) return pagesResult(failure('deployment_content_unavailable', 'send'));
      const io = pagesIo(context), providerDeploymentId = input.priorDeployment.providerDeploymentId;
      const reply = await request(io, input.providerIdentity.providerAccountId,
        `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}/deployments/${encodeURIComponent(providerDeploymentId)}/rollback`, 'send', ['write', 'POST']);
      if ('code' in reply) return pagesResult(reply);
      const result = pagesDeploymentResult(reply.value, { ...input, providerDeploymentId }, io, 'send');
      return pagesResult('code' in result ? failure('outcome_unknown', 'send') : result);
    } },
} as const;
