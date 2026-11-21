import {
  DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetLogsResultV1ProtocolSchema as output,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayGraphql } from './account.js';
import { railwayRoleInput } from './coordinates.js';

// The official Railway CLI uses this default for finite build and runtime reads.
// https://github.com/railwayapp/cli/blob/f3aa33472afe4b8f26b88edc540039afe2505ea0/src/commands/logs.rs#L855-L900
const snapshotLines = 500;
const logRows = defineProtocolArray(defineProtocolObject({ message: defineProtocolString() }, { policy: 'additive-open/drop' }));

function logsAction(kind: 'build' | 'runtime', field: 'buildLogs' | 'deploymentLogs') {
  const schema = inputs[`logs.${kind}`];
  const query = `query($deploymentId: String!, $limit: Int) {
    ${field}(deploymentId: $deploymentId, limit: $limit) { message }
  }`;
  return {
    ...railwayAccountAction,
    title: `Read the selected Railway ${kind} logs`,
    dangerLevel: 'safe',
    readOnly: true,
    inputSchema: railwayRoleInput(schema.jsonSchema),
    resultSchema: output.jsonSchema,
    async run(raw: JsonValue, context: PluginAccountActionContext): Promise<ReturnType<typeof output.parse>> {
      // The deployment role admission owns the retained ID and links it to the selected Railway service.
      const input = raw as unknown as ReturnType<typeof schema.parse>;
      const sourceRevision = input.providerDeploymentId;
      if (!sourceRevision) throw new PluginError({ code: 'deployment_content_unavailable' });
      if (input.cursor && input.cursor.sourceRevision !== sourceRevision) return { kind: 'source-changed', sourceRevision };
      // Railway's date filters cannot identify the split point between rows with the same timestamp.
      if (input.cursor || ('ref' in input && input.ref !== undefined)) return { kind: 'unavailable', reason: 'unsupported' };

      try {
        const data = await railwayGraphql(context)(query, { deploymentId: sourceRevision, limit: snapshotLines });
        const result = logRows.safeParse(data[field]);
        if (!result.success) throw new RailwayNativeError('railway_invalid_response');
        const rows = result.data;
        // The Railway CLI also drops the extra row that the API can return beyond its requested limit.
        const text = rows.slice(-snapshotLines).map(({ message }) => message.endsWith('\n') ? message : `${message}\n`).join('');
        return { kind: 'page', page: { sourceRevision, text, nextCursor: null, truncated: rows.length >= snapshotLines } };
      } catch (error) {
        return projectRailwayFailure(error, context, `logs.${kind}`);
      }
    },
  } as const;
}

export const buildLogsAction = logsAction('build', 'buildLogs');
export const runtimeLogsAction = logsAction('runtime', 'deploymentLogs');
