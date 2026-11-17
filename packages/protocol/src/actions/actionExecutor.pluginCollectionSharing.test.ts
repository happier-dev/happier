import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec } from './actionSpecs.js';
import { isActionDiscoverableOnToolSurface } from './actionToolExposure.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createActionExecutor } from './actionExecutor.js';
import { createPluginCollectionSharingActionExecuteV1 } from '../plugins/data/collectionSharingActionsV1.js';
import { createPluginCollectionSharingClientV1 } from '../plugins/data/collectionSharingClientV1.js';
import { normalizePluginAccountCollectionContractV1 } from '../plugins/data/collectionsV1.js';
import { PluginCollectionSharingGetRequestV1Schema } from '../plugins/data/collectionSharingV1.js';

describe('Contributed Collection logical sharing Actions', () => {
  it('delegates requester custody for valid native client operations and refuses malformed operands', () => {
    const collectionRef = { pluginId: 'example.documents', collectionId: 'documents', schemaVersion: 1, contractDigest: 'a'.repeat(43) };
    const principal = { kind: 'account', accountId: 'peer' };
    for (const [actionId, input] of [
      ['plugins.collections.shared.list', { collectionRef }],
      ['plugins.collections.shared.get', { collectionRef, ownerAccountId: 'owner', rowId: 'document' }],
      ['plugins.collections.shared.put', { collectionRef, ownerAccountId: 'owner', value: { id: 'document' }, expectedRevision: 1 }],
      ['plugins.collections.shared.grants.list', { collectionRef, rowId: 'document' }],
      ['plugins.collections.shared.grants.set', { collectionRef, rowId: 'document', principal, accessLevel: 'view', expectedRevision: 1 }],
      ['plugins.collections.shared.grants.revoke', { collectionRef, rowId: 'document', principal }],
    ] as const) {
      expect(getActionSpec(actionId).inputSchema.safeParse(input).success, actionId).toBe(true);
      expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId, input }), actionId).toBe(true);
      expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId,
        input: { ...input, encryptedDataKey: 'caller-supplied-material' } }), actionId).toBe(false);
    }
  });

  it('discovers native Collection reads and mutations with the canonical Ask policy', () => {
    for (const [rawId, mutation] of [
      ['plugins.collections.shared.list', false],
      ['plugins.collections.shared.get', false],
      ['plugins.collections.shared.put', true],
      ['plugins.collections.shared.grants.list', false],
      ['plugins.collections.shared.grants.set', true],
      ['plugins.collections.shared.grants.revoke', true],
    ] as const) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), id).toBe(true);
      expect(spec).toMatchObject({ executionPlacement: 'client', requiredAuthority: 'account_automation',
        surfaces: { ui: true, cli: true, agent: true, mcp: true }, safety: mutation ? 'danger' : 'safe' });
      expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { surface: 'mcp', authority: 'account_automation' } }).required, id).toBe(mutation);
    }
  });

  it('preserves a real Collection transport refusal and never exposes an unavailable logical value', async () => {
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'example.documents', contribution: {
      id: 'documents', schemaVersion: 1, rowIdField: 'id', identityFields: [],
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
    } });
    const client = createPluginCollectionSharingClientV1({ accountId: 'peer', contract,
      isValidLogicalValue: (value): value is { id: string } => typeof value.id === 'string',
      parseStoredLogicalValue: value => typeof value.id === 'string' ? { id: value.id } : null,
      requireCurrent: () => {},
      crypto: { accountMaterial: null, randomBytes: length => new Uint8Array(length), openKey: async () => null },
      // Authenticated HTTP is the only substituted boundary; parsing and refusal classification stay real.
      request: async (_path, body) => {
        expect(PluginCollectionSharingGetRequestV1Schema.parse(body)).toMatchObject({ ownerAccountId: 'owner', rowId: 'document' });
        return { status: 404, body: { error: 'collection_unavailable' } };
      },
    });
    const controller = new AbortController();
    let resolvedSignal: AbortSignal | undefined;
    const executor = createActionExecutor({ pluginCollectionSharingAction: createPluginCollectionSharingActionExecuteV1({
      resolveClient: async (_ref, signal) => { resolvedSignal = signal; return client; },
    }) });
    const result = await executor.execute('plugins.collections.shared.get', {
      collectionRef: { pluginId: contract.pluginId, collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest },
      ownerAccountId: 'owner', rowId: 'document',
    }, { surface: 'ui', authority: 'present_user', signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'collection_unavailable', details: { outcome: 'refused' } });
    expect(result).not.toHaveProperty('result');
    expect(resolvedSignal).toBe(controller.signal);
  });
});
