import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { createCustomAcpAdmissionRuntimeFixture } from './customAcpAdmission.testkit';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

// Canonical SDK unit fixture: activation uses the actual source contribution.
// It proves admission and projection, not packaged module-byte integrity.
let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createCustomAcpAdmissionRuntimeFixture();
});
afterAll(async () => { await runtime?.dispose(); });

function readyCatalog(): AcpCatalogSnapshotV1 {
  return { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({ v: 1,
    definitions: ['review-a', 'review-b'].map(id => ({ id, name: id, title: id,
      command: `command-${id}`, args: [id], env: {}, createdAt: 1, updatedAt: 2,
      capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
        supportsConfigOptions: 'unknown', promptImageSupport: 'no' } })) }) };
}

function prepare(definitionId: string, catalog = readyCatalog(), legacy = false) {
  return prepareExecuteSpawnSessionRequest({ request: {
    options: { directory: '/tmp/custom-acp-admission', machineId: 'machine-1',
      ...(legacy ? { backendTarget: { kind: 'backend' as const, backendId: definitionId,
        configuredBackendId: definitionId, sourceKind: 'configured' as const } }
        : { agentTarget: { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId } }) },
    acpCatalogSnapshot: catalog, credentials: { token: 'owner-token', encryption: null },
  }, validateEnvVarRecordStrict });
}

describe('definition-qualified Custom ACP daemon admission', () => {
  it('retains two definition selections in the existing runner runtime descriptor', async () => {
    const routingId = [...runtime.registry.contributes.agentDefinitionsById.values()]
      .find(agent => agent.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId)?.id;
    expect(routingId).toBeTruthy();
    for (const definitionId of ['review-a', 'review-b']) {
      expect(await prepare(definitionId)).toMatchObject({
        catalogAgentId: routingId,
        runtimeDescriptorV1: { v: 1, agentId: routingId, agent: { definitionId } },
        effectiveBackendTargetV2: { backendId: routingId, sourceKind: 'built_in' },
      });
    }
  });

  it('translates the predecessor configured carrier into the same declared contribution', async () => {
    expect(await prepare('review-a', readyCatalog(), true)).toMatchObject({
      runtimeDescriptorV1: { v: 1, agent: { definitionId: 'review-a' } },
      effectiveBackendTargetV2: { sourceKind: 'built_in' },
    });
  });

  it('refuses a deleted or unavailable definition rather than admitting an unqualified runtime', async () => {
    for (const catalog of [{ status: 'ready', revision: 5, record: { v: 1, definitions: [] } },
      { status: 'unavailable', reason: 'unreachable' }] satisfies AcpCatalogSnapshotV1[]) {
      expect(await prepare('review-a', catalog)).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
    }
  });

  it('refuses the bare contributed runtime without a selected definition', async () => {
    const routingId = [...runtime.registry.contributes.agentDefinitionsById.values()]
      .find(agent => agent.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId)?.id;
    if (!routingId) throw new Error('Expected the admitted Custom ACP contribution');
    expect(await prepareExecuteSpawnSessionRequest({ request: {
      options: { directory: '/tmp/custom-acp-admission',
        backendTarget: { kind: 'backend', backendId: routingId, sourceKind: 'built_in' } },
      credentials: { token: 'owner-token', encryption: null }, acpCatalogSnapshot: readyCatalog(),
    }, validateEnvVarRecordStrict })).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
  });
});
