import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { pluginPublicationReviewedChildren } from './specs/pluginPublication.js';
import { createBotTemplateActionExecuteV1 } from '../bots/templates/botTemplateOperations.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

const botTemplate = { draftArtifactId: '8e60ee82-ac53-4f6f-b04c-ff7ef873b9c9', expectedRevision: { headerVersion: 1, bodyVersion: 2 },
  release: { v: 1, version: '1.0.0', releasedAtMs: 100, changelog: 'Initial release', content: { v: 1,
    identity: { name: 'Garden', description: 'Garden advice', madeFromName: 'Garden Bot' },
    instructions: { markdown: 'Explain tradeoffs.' }, memoryRules: [], skills: [],
    needs: { software: [], connectedAccounts: [], mcpServers: [] } } } } as const;

describe('plugin publication Action contracts', () => {
  it.each(['approve', 'reject'] as const)('keeps the template release under the original Account and one parent review (%s)', async decision => {
    const artifacts = createWorkBoardArtifactBoundary();
    const releaseId = '64a6bc9c-0418-44f6-a593-8a751bde13e0';
    const ids = [botTemplate.draftArtifactId, releaseId];
    const originalAccountId = 'requester-account';
    const template = createBotTemplateActionExecuteV1({
      artifacts: artifacts.forAccount(originalAccountId), randomId: () => ids.shift()!, nowMs: () => 999,
      readSourceDraftRef: async () => null, writeSourceDraftRef: async () => {}, grant: async () => {},
    });
    let stored: ApprovalRequest | null = null;
    let reviews = 0;
    const effects: string[] = [];
    const releaseContexts: ActionExecutorContext[] = [];
    const executor = createActionExecutor({
      botTemplateAction: async args => {
        if (args.actionId === 'template.release') releaseContexts.push(args.context);
        return template(args);
      },
      approvalsCreate: async ({ request }) => { reviews++; stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'publish-review' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing publication approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      // This port is the Machine publication boundary. The canonical executor,
      // reviewed-child admission and template Artifact producer remain real.
      pluginsDevLoopAction: async ({ actionId, input, context }) => {
        if (actionId === 'plugins.dev.publish') {
          const child = pluginPublicationReviewedChildren(input)[0]!;
          if (child.input === undefined) throw new Error('Missing reviewed release input');
          const released = await context.hostReviewedChild!.invoke({ action: child.action, role: child.role, input: child.input });
          if (!released.ok) return released;
          effects.push('upload');
        }
        return { ok: true, kind: actionId.replaceAll('.', '_'), result: { status: 'failed', diagnostics: [] } };
      },
    });
    const person: ActionExecutorContext = { surface: 'ui', authority: 'present_user', serverId: 'home',
      serverIdentityId: 'home-identity', runtimeAccountId: originalAccountId, actionCaller: { kind: 'host' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    const drafted = await executor.execute('template.draft', { sourceSessionRef: { serverId: 'home', sessionId: 'bot' },
      content: botTemplate.release.content }, person);
    expect(drafted).toMatchObject({ ok: true });
    const input = { botTemplate: { ...botTemplate, expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
      machineId: 'shared-machine', publication: { version: '1.2.0', changelog: 'Reviewed notes' }, access: 'public', mode: 'direct' };
    const agent: ActionExecutorContext = { ...person, surface: 'agent', authority: 'account_automation', actionRequestId: 'publish-request' };
    expect(await executor.execute('plugins.dev.publication.prepare', { botTemplate: input.botTemplate }, agent)).toMatchObject({ ok: true });
    expect(artifacts.rows.size).toBe(1);
    const proposed = await executor.execute('plugins.dev.publish', input, agent);
    expect(proposed, JSON.stringify(proposed))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(artifacts.rows.size).toBe(1);
    expect(effects).toEqual([]);
    const decided = await executor.execute('approval.request.decide', { artifactId: 'publish-review', decision }, person);
    expect(reviews).toBe(1);
    if (decision === 'reject') {
      expect(decided).toMatchObject({ ok: true, result: { status: 'rejected' } });
      expect(artifacts.rows.has(releaseId)).toBe(false);
      expect(effects).toEqual([]);
      return;
    }
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(artifacts.rows.get(releaseId)).toMatchObject({ ownerAccountId: originalAccountId });
    expect(JSON.parse(String(artifacts.rows.get(releaseId)!.body))).toMatchObject({ state: 'released', release: {
      version: '1.2.0', changelog: 'Reviewed notes', releasedAtMs: 100, content: botTemplate.release.content,
    } });
    expect(releaseContexts.map(context => context.runtimeAccountId)).toEqual([originalAccountId]);
    expect(effects).toEqual(['upload']);
  });

  it('prepares a reviewed template without a source folder and admits its exact release only on final publication', () => {
    const input = { botTemplate, publication: { version: '1.2.0', changelog: 'New release' }, access: 'public', mode: 'direct' };
    expect(getActionSpec('plugins.dev.publication.prepare').inputSchema.safeParse({ botTemplate }).success).toBe(true);
    expect(getActionSpec('plugins.dev.publish').inputSchema.safeParse(input).success).toBe(true);
    expect(getActionSpec('plugins.dev.publish').inputSchema.safeParse({ ...input, github: {
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'fixture/garden' }, release: { tagName: 'v1.2.0', targetCommitish: 'main',
        name: 'Garden', body: 'New release', prerelease: false, makeLatest: 'false' } } }).success).toBe(true);
    expect(getActionSpec('plugins.dev.publication.prepare').inputSchema.safeParse({}).success).toBe(false);
    expect(pluginPublicationReviewedChildren(input)).toContainEqual({ action: 'template.release', role: 'bot-template-release',
      input: { draftArtifactId: botTemplate.draftArtifactId, expectedRevision: botTemplate.expectedRevision,
        version: '1.2.0', changelog: 'New release', releasedAtMs: 100 } });
    expect(pluginPublicationReviewedChildren({ ...input, githubOnly: true }).some(child => child.action === 'template.release')).toBe(false);
  });
  it('offers safe inspection/recovery, preparation without another Ask, and reviewed public publication', () => {
    for (const id of ['plugins.dev.publication.inspect', 'plugins.dev.publication.prepare', 'plugins.dev.publish', 'plugins.dev.publication.status']) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
    }
    const inspect = getActionSpec('plugins.dev.publication.inspect');
    expect(inspect.safety).toBe('safe');
    expect(getActionSpec('plugins.dev.publication.status').safety).toBe('safe');
    const prepare = getActionSpec('plugins.dev.publication.prepare');
    expect(isAgentInitiatedApprovalRequiredByDefault(prepare.id)).toBe(false);
    const publish = getActionSpec('plugins.dev.publish');
    expect(publish.safety).toBe('danger');
    expect(isAgentInitiatedApprovalRequiredByDefault(publish.id)).toBe(true);
    expect(publish.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: true });
    expect(publish.inputSchema.safeParse({ projectRoot: '/plugin', access: 'public', mode: 'staged',
      publication: { title: 'A plugin', icon: { iconResourceId: 'face' } } }).success).toBe(true);
    expect(publish.inputSchema.safeParse({ projectRoot: '/plugin', access: 'public', mode: 'direct',
      publication: { iconSource: { dataBase64: 'reviewed-png-bytes', contentType: 'image/png' } } }).success).toBe(true);
    expect(publish.inputSchema.safeParse({ projectRoot: '/plugin', access: 'public', mode: 'direct', token: 'private' }).success).toBe(false);
    expect(publish.inputSchema.safeParse({ projectRoot: '/plugin', access: 'private', mode: 'direct' }).success).toBe(false);
  });

  it('stores one default agent publication approval before dispatch and prepares without an Ask', async () => {
    const approvals: unknown[] = [];
    const dispatched: string[] = [];
    // The two ports replace approval persistence and Machine network transport;
    // admission and approval policy execute their production implementations.
    const executor = createActionExecutor({
      isActionApprovalRequired: (actionId, context, input) => resolveActionApprovalRouting({
        actionId, spec: getActionSpec(actionId), input, context,
      }).required,
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'publication-approval' }; },
      pluginsDevLoopAction: async ({ actionId }) => {
        dispatched.push(actionId);
        return { ok: true, kind: actionId.replaceAll('.', '_'), result: { status: 'failed', diagnostics: [] } };
      },
    } as ActionExecutorDeps);
    const context = { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId: 'publication-session', starterDepth: 0, turnDepth: 0 },
      serverId: 'home', actionRequestId: 'publication-request' } as const;
    expect(await executor.execute('plugins.dev.publication.prepare', { projectRoot: '/plugin', machineId: 'machine' }, context))
      .toMatchObject({ ok: true });
    expect(approvals).toEqual([]);
    expect(await executor.execute('plugins.dev.publish', { projectRoot: '/plugin', machineId: 'machine', access: 'public', mode: 'direct' }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ actionId: 'plugins.dev.publish', actionArgs: { machineId: 'machine', projectRoot: '/plugin' } });
    expect(dispatched).toEqual(['plugins.dev.publication.prepare']);
  });
});
