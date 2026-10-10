import { describe, expect, it } from 'vitest';

import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { parseWorkflowDocumentJsonIngressV1, serializeWorkflowDocumentJsonV1 } from '../../workflows/workflowDocumentV1.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'wait' as const, id: 'review',
  document: { text: 'Continue', references: [], attachments: [] } }] };
const document = { kind: 'happier.workflow' as const, version: 1 as const, definition };

function owner() {
  const unexpected = (): never => { throw new Error('document_interchange_has_no_effects'); };
  return createWorkflowDefinitionActions({ artifactStore: {
    // Artifact persistence is the boundary; document parsing and saved content opening remain real.
    read: async () => ({ artifactId: definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
      ownerAccountId: 'account', access: 'view', header: { kind: 'workflow-definition.v1', definitionId,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved wait' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
    list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
  }, assertDefinitionWriteAllowed: unexpected, encodeListCursor: unexpected });
}

describe('Workflow document Actions', () => {
  it('classifies imported documents as unsaved and preserves typed codec failures without saving or starting', async () => {
    const json = JSON.stringify(document);
    await expect(owner().importDocument({ json })).resolves.toEqual({ ...parseWorkflowDocumentJsonIngressV1(json),
      classification: 'unsaved_definition' });
    await expect(owner().importDocument({ json: '{' })).resolves.toEqual({ ok: false,
      code: 'workflow_document_invalid_json', issues: [] });
    await expect(owner().importDocument({ json: JSON.stringify({ ...document, version: 2 }) })).resolves.toMatchObject({
      ok: false, code: 'workflow_document_unsupported_version', version: 2 });
    await expect(owner().importDocument({ json: JSON.stringify({ ...document, credentials: 'excluded' }) })).resolves.toMatchObject({
      ok: false, code: 'workflow_document_invalid' });
  });

  it('exports an authorized saved definition with its revision and only the canonical portable envelope', async () => {
    const exported = await owner().exportDocument({ definitionId });
    expect(exported).toEqual({ definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
      metadata: { title: 'Saved wait' }, document, json: serializeWorkflowDocumentJsonV1(document) });
    expect(JSON.parse(exported.json)).toEqual(document);
  });
});
