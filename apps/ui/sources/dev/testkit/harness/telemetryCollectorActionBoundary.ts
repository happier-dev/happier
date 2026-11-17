import tweetnacl from 'tweetnacl';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DatabaseCaptureCostsReadInputV1Schema, type DatabaseCaptureCostsReadInputV1, type DatabaseCaptureCostsReadResultV1 } from '@happier-dev/database-protocol';
import { TELEMETRY_COSTS_READ_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '../fixtures/machineFixtures';
import type { ServedHomeRequest } from './actionHomesHttpHarness';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

/**
 * An Environment's telemetry collector Machine at its Home HTTP boundary, for `serveActionHomes` routes: the Machine
 * rows, the Home's execution authorization and the forwarded `action.invoke` of happier.telemetry `capture/costs/read`.
 * Account capture, requester provenance, envelope digests and the Action front door stay real; only the collector's
 * answer (`readCosts`) is the fixture.
 */
export function createTelemetryCollectorActionBoundary(
  params: Readonly<{
    machineId: string;
    accountId: string;
    serverIdentityId: string;
    readCosts(
      input: DatabaseCaptureCostsReadInputV1,
    ): DatabaseCaptureCostsReadResultV1;
  }>,
) {
  const installation = tweetnacl.sign.keyPair.fromSeed(
    new Uint8Array(32).fill(7),
  );
  const machine = {
    ...createPlainMachineRowFixture({
      id: params.machineId,
      accountId: params.accountId,
    }),
    active: true,
    installationId: `${params.machineId}-installation`,
    installationPublicKey: encodeBase64(installation.publicKey),
  };
  const localId = databaseActionLocalIdV1(TELEMETRY_COSTS_READ_ACTION_ID_V1);
  const reads: DatabaseCaptureCostsReadInputV1[] = [];
  // The collector's daemon projects the costs read as an ordinary daemon plugin Action (as the picker boundary does).
  const executionOrigin = { serverIdentityId: params.serverIdentityId, materializationRef: {
    pluginId: 'happier.telemetry', machineId: params.machineId, materializationId: 'telemetry-current' } };
  const projected = PluginProjectedActionV2Schema.parse({ id: localId, pluginId: 'happier.telemetry', title: 'Read selected app LLM cost operands',
    scopes: ['global'], surfaces: ['ui', 'plugin'], execution: { target: 'daemon' }, dangerLevel: 'safe', readOnly: true,
    occurrenceId: 'happier.telemetry:costs', available: true, executionOrigin });
  const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
    v: 2, generation: 1, installedPackagesById: {}, agentsById: {},
    actionsById: { [`happier.telemetry/${localId}`]: projected }, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
  } });
  return {
    machine,
    /** Every costs read the collector answered, as it received it. */
    reads,
    /**
     * The Account's committed AppShell plugin projection names the collector's telemetry costs read, as the app shell
     * publishes it once the Machine's plugins are current. Returns the withdrawal.
     */
    publishCommittedProjection(serverId: string): () => void {
      const union = unionPluginUiProjections([{ machineId: params.machineId, serverId, serverIdentityId: params.serverIdentityId,
        selectableExecutionOrigins: [executionOrigin], phase: 'current', interactionEnabled: true,
        projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1, actionsById: { [`happier.telemetry/${localId}`]: projected } } }],
      new Map([['happier.telemetry', executionOrigin]]));
      return publishCommittedAppShellPluginUiProjection(() => union.pluginUiProjection);
    },
    /** The collector daemon's own RPC answers (`machineRpcWithServerScope` boundary): its plugin projection and schemas. */
    async answerDaemonRpc(request: Readonly<{ method: string }>): Promise<unknown> {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return projection;
      if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
      throw new Error(`Unanswered collector RPC: ${request.method}`);
    },
    handle(
      request: Pick<ServedHomeRequest, 'path' | 'body'>,
    ): Response | undefined {
      if (request.path === '/v1/machines') return Response.json([machine]);
      if (request.path === `/v1/machines/${params.machineId}`)
        return Response.json({ machine });
      if (request.path === '/v1/machines/read-batch')
        return createMachineReadBatchResponseFixture(request.body, (id) =>
          id === params.machineId ? machine : null,
        );
      if (
        request.path === '/v1/actions/action.invoke/execution-authorization'
      ) {
        const { envelope } =
          ExternalActionExecutionAuthorizationRequestV1Schema.parse(
            request.body,
          );
        return Response.json({
          v: 1,
          token: `${params.machineId}-action-proof`,
          binding: {
            serverIdentityId: params.serverIdentityId,
            accountId: params.accountId,
            authentication: { kind: 'account', tokenEpoch: 0 },
            actionId: 'action.invoke',
            requestId: envelope.requestId,
            target: envelope.target,
            machineId: params.machineId,
            installationId: machine.installationId,
            custodianAccountId: params.accountId,
            accountEncryptionMode: 'plain',
            machineRuntimeDemand: 'required',
            requestEnvelopeDigest:
              computeExternalActionRequestEnvelopeDigestV1(envelope),
          },
        });
      }
      if (request.path !== '/v1/actions/action.invoke') return undefined;
      const forwarded = ExternalActionRequestEnvelopeV1Schema.safeParse(
        request.body,
      );
      const envelope = forwarded.success
        ? forwarded.data
        : ExternalActionExecutionAuthorizationRequestV1Schema.parse(
            request.body,
          ).envelope;
      const invoked = envelope.input as {
        action?: { pluginId?: string; localId?: string };
        input?: unknown;
      };
      if (
        envelope.target?.kind !== 'machine' ||
        envelope.target.machineId !== params.machineId ||
        invoked.action?.pluginId !== 'happier.telemetry' ||
        invoked.action.localId !== localId
      )
        return undefined;
      const input = DatabaseCaptureCostsReadInputV1Schema.parse(invoked.input);
      reads.push(input);
      return Response.json({
        v: 1,
        actionId: 'action.invoke',
        requestId: envelope.requestId,
        execution: { ok: true, result: params.readCosts(input) },
      });
    },
  };
}
