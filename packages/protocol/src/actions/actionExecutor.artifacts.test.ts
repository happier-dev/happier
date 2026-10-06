import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { prepareArtifactHeaderForRevisionV1 } from '../artifacts/artifactHeaderRestorationV1.js';
import { buildWorkBoardArtifactHeaderV1, readWorkBoardArtifactSummaryV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';

const ids = ['artifact.create', 'artifact.get', 'artifact.list', 'artifact.update', 'artifact.delete',
  'artifact.publish_from_file', 'artifact.revisions.list', 'artifact.revisions.restore', 'artifact.storage.usage'] as const;

describe('ordinary Artifact Actions', () => {
  it('offers owner public-link audit as an approval-default egress read', () => {
    const actionId = 'artifact.public_link.audit' as ActionId;
    expect(ActionIdSchema.safeParse(actionId).success).toBe(true);
    const spec = getActionSpec(actionId);
    expect(spec.sideEffectClass).toBe('read');
    expect(spec.safety).toBe('safe');
    expect(spec.inputSchema.safeParse({ artifactId: 'artifact', shareId: 'share' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ artifactId: 'artifact', shareId: 'share', accountId: 'foreign' }).success).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
  });
  it.each(['artifact.create', 'artifact.update', 'artifact.publish_from_file', 'artifact.get'] as const)('returns %s private HTML preview only to the caller, not shared observations', async actionId => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const previewUrl = 'https://isolated.example/a/document#d=PRIVATE_HTML_SENTINEL';
    const artifact = { artifactId, header: { kind: 'html' }, body: '<p>HTML</p>', revision, ownerAccountId: 'owner', access: 'owner', seq: 1, createdAt: 1, updatedAt: 1 };
    const output = actionId === 'artifact.get' ? { artifact, previewUrl } : { artifactId, revision, previewUrl };
    const input = actionId === 'artifact.create' ? { artifactId, header: artifact.header, body: artifact.body }
      : actionId === 'artifact.update' ? { artifactId, header: artifact.header, body: artifact.body, expectedRevision: revision }
      : actionId === 'artifact.get' ? { artifactId } : { path: 'document.html' };
    const observeActionExecution = vi.fn(async () => {});
    const executor = createActionExecutor({ artifactAction: async () => output, isActionApprovalRequired: () => false,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }), observeActionExecution });
    expect(await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } })).toEqual({ ok: true, result: output });
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain('PRIVATE_HTML_SENTINEL');
  });
  it('keeps public-link material out of Action inputs and requires approval by default', () => {
    for (const id of ['artifact.public_link.create', 'artifact.public_link.list', 'artifact.public_link.revoke'] as const) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      const spec = getActionSpec(id as ActionId);
      const input = id.endsWith('revoke') ? { artifactId: 'artifact-1', shareId: 'share-1' } : { artifactId: 'artifact-1' };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, secret: 'must-remain-local' }).success).toBe(false);
      if (id === 'artifact.public_link.create') expect(spec.inputSchema.safeParse({ ...input, expiresAt: 0 }).success).toBe(true);
      expect(spec.sideEffectClass).toBe(id === 'artifact.public_link.list' ? 'read' : 'write');
      expect(resolveActionApprovalRouting({ actionId: id as ActionId, spec,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      expect(spec.outputSchema.safeParse({ publicShare: { secret: 'must-remain-local' } }).success).toBe(false);
    }
  });
  it.each(['artifact.public_link.create', 'session.public_link.create'] as const)('returns %s URL to the caller while redacting shared observations', async actionId => {
    const settings = { id: 'share', expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    const output = actionId === 'artifact.public_link.create'
      ? { publicShare: { ...settings, subject: { kind: 'artifact', id: 'artifact' } }, url: 'https://public.example/s/lookup#k=SECRET_FOR_CALLER' }
      : { id: settings.id, expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, updatedAt: 1, url: 'https://public.example/s/lookup#k=SECRET_FOR_CALLER' };
    const observeActionExecution = vi.fn(async () => {});
    const executor = createActionExecutor({ artifactAction: async () => output, sessionAccessAction: async () => output,
      isActionApprovalRequired: () => false, interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution });
    const result = await executor.execute(actionId, actionId === 'artifact.public_link.create' ? { artifactId: 'artifact' } : { sessionId: 'session' },
      { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } });
    expect(result).toEqual({ ok: true, result: output });
    expect(observeActionExecution).toHaveBeenCalled();
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain('SECRET_FOR_CALLER');
  });
  it('offers reads and approval-based writes to Agents, MCP and CLI through the canonical catalog', () => {
    for (const id of ids) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      const spec = getActionSpec(id as ActionId);
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, cli: true, ui: true });
      expect(spec.requiredAuthority).toBe('account_automation');
      const read = ['artifact.get', 'artifact.list', 'artifact.revisions.list', 'artifact.storage.usage'].includes(id);
      expect(spec.safety).toBe(read ? 'safe' : 'danger');
      expect(resolveActionApprovalRouting({ actionId: id as ActionId, spec,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(!read);
    }
  });

  it('settles quota refusal without losing the configured budget details', async () => {
    const quota = { ok: false, errorCode: 'quota_exceeded', error: 'quota_exceeded',
      details: { budget: 'account', limitBytes: 100, usedBytes: 110 } };
    const executor = createActionExecutor({ artifactAction: async () => quota,
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('artifact.create' as ActionId, { header: { title: 'Test' }, body: 'text' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject(quota);
  });

  it('requires a read revision for destructive mutation and refuses caller-authored publish provenance', () => {
    expect(getActionSpec('artifact.delete' as ActionId).inputSchema.safeParse({ artifactId: 'artifact-1' }).success).toBe(false);
    expect(getActionSpec('artifact.publish_from_file' as ActionId).inputSchema.safeParse({ path: 'result.md',
      source: { sessionId: 'foreign', machineId: 'foreign', path: '/private' } }).success).toBe(false);
  });

  it('accepts one caller-workspace upload path instead of text and refuses ambiguous or caller-authored blob inputs', () => {
    for (const id of ['artifact.create', 'artifact.update'] as const) {
      const spec = getActionSpec(id);
      const identity = id === 'artifact.update' ? { artifactId: 'artifact-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 } } : {};
      expect(spec.inputSchema.safeParse({ ...identity, header: {}, uploadPath: 'images/result.png', mime: 'image/png' }).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...identity, header: {}, body: 'text', uploadPath: 'images/result.png' }).success).toBe(false);
      expect(spec.inputSchema.safeParse({ ...identity, header: {}, body: { blobId: 'foreign' } }).success).toBe(false);
    }
  });

  it('restores Board list and Inbox membership from the historical body, not the displaced header', () => {
    const current = createWorkBoardV1({ id: 'board-1', name: 'Current' });
    const historical = { ...current, name: 'Prior', pinnedInSessions: true,
      source: { picked: [], sections: ['needs_you'] } };
    const header = prepareArtifactHeaderForRevisionV1({ artifactId: current.id,
      header: { ...buildWorkBoardArtifactHeaderV1(current), source: { sessionId: 'session-1' } },
      body: JSON.stringify(historical), expectedRevision: { headerVersion: 2, bodyVersion: 2 },
      nextRevision: { headerVersion: 3, bodyVersion: 3 } });
    expect(readWorkBoardArtifactSummaryV1(current.id, header)).toEqual({
      id: 'board-1', name: 'Prior', pinnedInSessions: true, source: { sections: ['needs_you'] },
    });
    expect(header).not.toHaveProperty('source');
  });
  it('restores Workflow preview labels from the selected definition rather than its displaced header', () => {
    const definitionId = '11111111-1111-4111-8111-111111111111';
    const header = prepareArtifactHeaderForRevisionV1({ artifactId: definitionId,
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 2, bodyVersion: 2 },
        metadata: { title: 'Workflow' }, previewSteps: ['Displaced step'] },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'prior', document: { text: 'Historical step', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }] } }),
      expectedRevision: { headerVersion: 2, bodyVersion: 2 }, nextRevision: { headerVersion: 3, bodyVersion: 3 } });
    expect(header.previewSteps).toEqual(['Historical step']);
    expect(header.revision).toEqual({ headerVersion: 3, bodyVersion: 3 });
  });
});
