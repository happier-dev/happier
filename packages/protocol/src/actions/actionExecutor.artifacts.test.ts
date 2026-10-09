import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { prepareArtifactHeaderForRevisionV1 } from '../artifacts/artifactHeaderRestorationV1.js';
import { buildWorkBoardArtifactHeaderV1, readWorkBoardArtifactSummaryV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import { ArtifactActionInputSchemasV1, type ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { z } from 'zod';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1 } from '../widgets/widgetSurfaceArtifactV1.js';

function openedArtifactBoundary(initial: z.infer<typeof ArtifactDocumentV1Schema>) {
  const artifacts = new Map([[initial.artifactId, initial]]);
  // The opened, authenticated Artifact Action transport is the genuine boundary.
  // Action admission, kind policy and the document's actual header/body stay real.
  const action: NonNullable<ActionExecutorDeps['artifactAction']> = async ({ actionId, input }) => {
    if (actionId === 'artifact.get') {
      const args = ArtifactActionInputSchemasV1[actionId].parse(input);
      return { artifact: artifacts.get(args.artifactId) ?? null };
    }
    if (actionId === 'artifact.create') {
      const args = ArtifactActionInputSchemasV1[actionId].parse(input);
      if (!args.artifactId || 'uploadPath' in args) throw new Error('Unexpected boundary request');
      const revision = { headerVersion: 1, bodyVersion: 1 };
      artifacts.set(args.artifactId, { ...initial, artifactId: args.artifactId, header: args.header, body: args.body, revision });
      return { artifactId: args.artifactId, revision };
    }
    if (actionId === 'artifact.delete') {
      const args = ArtifactActionInputSchemasV1[actionId].parse(input);
      const artifact = artifacts.get(args.artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'not_found' };
      if (JSON.stringify(artifact.revision) !== JSON.stringify(args.expectedRevision)) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
      artifacts.delete(args.artifactId);
      return { artifactId: args.artifactId, deleted: true };
    }
    if (actionId === 'artifact.update') {
      const args = ArtifactActionInputSchemasV1[actionId].parse(input);
      const artifact = artifacts.get(args.artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'not_found' };
      if ('uploadPath' in args) throw new Error('Unexpected boundary request');
      if (JSON.stringify(artifact.revision) !== JSON.stringify(args.expectedRevision)) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
      const revision = { headerVersion: artifact.revision.headerVersion + 1, bodyVersion: artifact.revision.bodyVersion + 1 };
      artifacts.set(args.artifactId, { ...artifact, header: args.header, body: args.body, revision });
      return { artifactId: args.artifactId, revision };
    }
    throw new Error(`Unexpected boundary Action: ${actionId}`);
  };
  return { action, read: () => artifacts.get(initial.artifactId) ?? null, exists: (id: string) => artifacts.has(id) };
}

const ids = ['artifact.create', 'artifact.get', 'artifact.list', 'artifact.update', 'artifact.delete',
  'artifact.publish_from_file', 'artifact.revisions.list', 'artifact.revisions.restore', 'artifact.storage.usage'] as const;

describe('ordinary Artifact Actions', () => {
  it('retains the admitted WorkBoard sharing projection on ordinary reads', async () => {
    const board = createWorkBoardV1({ id: 'board', name: 'Shared board' });
    const artifact = { artifactId: board.id, header: buildWorkBoardArtifactHeaderV1(board), body: JSON.stringify(board),
      ownerAccountId: 'owner', access: 'owner' as const, shared: true, revision: { headerVersion: 1, bodyVersion: 1 },
      seq: 1, createdAt: 1, updatedAt: 1 };
    const executor = createActionExecutor({ artifactAction: openedArtifactBoundary(artifact).action });
    expect(await executor.execute('artifact.get', { artifactId: board.id }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { artifact: { artifactId: board.id, shared: true, access: 'owner' } } });
  });
  it('refuses default dashboard deletion and shared-dashboard raw edits through ordinary Artifact admission', async () => {
    const base = { serverId: 'home', accountId: 'owner', owner: { kind: 'project', projectId: 'project' } } as const;
    for (const actionId of ['artifact.delete', 'artifact.update'] as const) {
      const surface = actionId === 'artifact.delete' ? base : { ...base, owner: { ...base.owner, dashboardId: 'shared' } };
      const layout = { v: 1 as const, surface, name: 'Dashboard', instances: [] };
      const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
      const initial = { artifactId, header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout),
        revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'owner', access: actionId === 'artifact.delete' ? 'owner' as const : 'edit' as const,
        seq: 1, createdAt: 1, updatedAt: 1 };
      const boundary = openedArtifactBoundary(initial);
      const executor = createActionExecutor({ artifactAction: boundary.action });
      const input = { artifactId, expectedRevision: initial.revision, ...(actionId === 'artifact.update'
        ? { header: { kind: 'ordinary', sortKey: 'overwrite-owner-order' }, body: JSON.stringify({ ...layout, surface: { ...surface, accountId: 'recipient' },
          instances: [{ instance: { v: 1, id: 'pin', definition: { kind: 'builtin', id: 'count' }, bindings: { connection: {
            kind: 'value', value: { service: { pluginId: 'cloud', localId: 'service' }, accountId: 'private' } } } } }] }) } : {}) };
      expect(await executor.execute(actionId, input, { surface: 'mcp', bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'artifact_kind_internal' });
      expect(boundary.read()).toEqual(initial);
    }
  });
  it('refuses manufacturing an internal dashboard header through generic create or an ordinary-document update', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const initial = { artifactId, header: { title: 'Ordinary' }, body: 'text', revision: { headerVersion: 1, bodyVersion: 1 },
      ownerAccountId: 'owner', access: 'owner' as const, seq: 1, createdAt: 1, updatedAt: 1 };
    const boundary = openedArtifactBoundary(initial);
    const executor = createActionExecutor({ artifactAction: boundary.action });
    for (const actionId of ['artifact.create', 'artifact.update'] as const) {
      expect(await executor.execute(actionId, { artifactId: actionId === 'artifact.create' ? '22222222-2222-4222-8222-222222222222' : artifactId, header: { kind: 'widget-area-layout.v1' }, body: '{}',
        ...(actionId === 'artifact.update' ? { expectedRevision: initial.revision } : {}) }, { surface: 'mcp', bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'artifact_kind_internal' });
    }
    expect(boundary.read()).toEqual(initial);
    expect(boundary.exists('22222222-2222-4222-8222-222222222222')).toBe(false);
  });
  it('retains ordinary-document mutation receipts and stale or missing transport refusals', async () => {
    const artifactId = 'ordinary';
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const boundary = openedArtifactBoundary({ artifactId, header: { kind: 'untyped-predecessor' }, body: 'before', revision,
      ownerAccountId: 'owner', access: 'owner', seq: 1, createdAt: 1, updatedAt: 1 });
    const executor = createActionExecutor({ artifactAction: boundary.action });
    const context = { surface: 'mcp', bypassApprovals: true } as const;
    expect(await executor.execute('artifact.update', { artifactId, expectedRevision: revision, header: { kind: 'untyped-predecessor' }, body: 'after' }, context))
      .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: revision }, context)).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(boundary.read()?.body).toBe('after');
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, context))
      .toEqual({ ok: true, result: { artifactId, deleted: true } });
    expect(await executor.execute('artifact.delete', { artifactId, expectedRevision: revision }, context)).toMatchObject({ ok: false, errorCode: 'not_found' });
  });
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
    const artifact = { artifactId, header: { kind: 'html' }, body: '<p>HTML</p>', revision, ownerAccountId: 'owner', access: 'owner', publicAudience: 'unknown', seq: 1, createdAt: 1, updatedAt: 1 };
    const output = actionId === 'artifact.get' ? { artifact, previewUrl } : { artifactId, revision, previewUrl };
    const input = actionId === 'artifact.create' ? { artifactId, header: artifact.header, body: artifact.body }
      : actionId === 'artifact.update' ? { artifactId, header: artifact.header, body: artifact.body, expectedRevision: revision }
      : actionId === 'artifact.get' ? { artifactId } : { path: 'document.html' };
    const observeActionExecution = vi.fn(async () => {});
    const executor = createActionExecutor({ artifactAction: async request => request.actionId === 'artifact.get' && actionId !== 'artifact.get'
      ? { artifact } : output, isActionApprovalRequired: () => false,
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
