import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetLogsResultV1ProtocolSchema as output,
  PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request } from './deploymentHttp.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';

/** Finite provider snapshot, with no invented history cursor or polling.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/subresources/history/subresources/logs/methods/get/
 * API schema observed 2026-11-10: result {data:[{line,ts}],total,includes_container_logs}.
 */
export const pagesLogsActions = {
  'pages-build-logs-read': { ...pagesCommon, title: 'Read the selected Cloudflare Pages build logs', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs['logs.build'].jsonSchema, resultSchema: output.jsonSchema,
    async run(raw: JsonValue, context: PluginAccountActionContext) {
      // The role owner already admitted the retained receipt and provider scope.
      const input = raw as unknown as ReturnType<typeof inputs['logs.build']['parse']>;
      const fail = (code: string): never => { throw new PluginError({ code, retryable: false, details: { phase: 'build' } }); };
      if (!input.providerDeploymentId || !input.preparedNative) return fail('deployment_content_unavailable');
      const sourceRevision = input.providerDeploymentId;
      if (input.cursor && input.cursor.sourceRevision !== sourceRevision) return { kind: 'source-changed', sourceRevision };
      const reply = await request(pagesIo(context), input.providerIdentity.providerAccountId,
        `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}/deployments/${encodeURIComponent(sourceRevision)}/history/logs`, 'build');
      if ('code' in reply) return fail(reply.code);
      const value = reply.value;
      if (!isObject(value) || !Array.isArray(value.data) || !Number.isSafeInteger(value.total)
        || typeof value.total !== 'number' || value.total < 0 || typeof value.includes_container_logs !== 'boolean') return fail('provider_response_invalid');
      const lines: string[] = [];
      for (const row of value.data) {
        if (!isObject(row) || typeof row.line !== 'string' || typeof row.ts !== 'string') return fail('provider_response_invalid');
        lines.push(row.line.endsWith('\n') ? row.line : `${row.line}\n`);
      }
      // The documented API has no paging parameters. Preserve any partial snapshot
      // and expose its incompleteness through the existing native log result.
      return { kind: 'page', page: { sourceRevision, text: lines.join(''), nextCursor: null,
        truncated: value.total > value.data.length } };
    } },
} as const;
