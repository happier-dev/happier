import tweetnacl from 'tweetnacl';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { ActionInvokeInputSchema } from '@happier-dev/protocol/actions/actionInvokeInput';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openExternalActionRequestV2, prepareExternalActionResponseV2,
  projectExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { getRandomBytes } from '@/platform/cryptoRandom';
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
    installationPublicKey: encodeBase64(installation.publicKey, "base64url"),
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
      const mint = request.path === '/v1/actions/action.invoke/execution-authorization';
      if (!mint && request.path !== '/v1/actions/action.invoke') return undefined;
      const { envelope, executionAuthorization } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
      if (envelope.v !== 2 || !envelope.telemetryCollectorCodec || envelope.target.kind !== 'machine'
        || envelope.target.machineId !== params.machineId || !envelope.deploymentReadAdmission
        || !('telemetryCollector' in envelope.deploymentReadAdmission)) return undefined;
      if (mint) {
        return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'fixture-telemetry-authorization',
          telemetryReadInstallationPublicKey: machine.installationPublicKey,
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
            machineRuntimeDemand: envelope.machineRuntimeDemand,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            telemetryCollectorCodec: true,
            deploymentReadAdmission: envelope.deploymentReadAdmission,
            deploymentTelemetryRead: envelope.deploymentReadAdmission.telemetryCollector.environmentIds.map(environmentId => ({
              environmentId, revision: 1, capabilities: { appLlmCost: true },
            })),
          },
        }));
      }
      if (!executionAuthorization) throw new Error('Expected a collector execution authorization');
      const material = openManagedControllerActionCodecV1({ authorization: executionAuthorization,
        machineId: params.machineId, installationId: machine.installationId,
        serverIdentityId: params.serverIdentityId, installationPrivateKey: installation.secretKey });
      if (!material) throw new Error('Could not open the collector execution codec');
      const binding = projectExternalActionEncryptionBindingV2(executionAuthorization.binding);
      const opened = openExternalActionRequestV2({ binding, envelope, material,
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
      const invoked = ActionInvokeInputSchema.parse(opened?.input);
      if (invoked.action.pluginId !== 'happier.telemetry' || invoked.action.localId !== localId) return undefined;
      const input = DatabaseCaptureCostsReadInputV1Schema.parse(invoked.input);
      reads.push(input);
      return Response.json(prepareExternalActionResponseV2({ binding, request: envelope, material,
        executedMachineId: params.machineId, randomBytes: getRandomBytes,
        execution: { ok: true, result: params.readCosts(input) } }).response);
    },
  };
}
