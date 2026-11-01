import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerDiscussionThreadForTests, createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { DocReadResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { AccountNoticeArtifactBodyV1Schema, AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { SessionTargetPreviewV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';

import {
  AccountSettingsV2UpdateRequestSchema,
  formatQualifiedPluginActionId,
  getActionSpec,
  type ActionDefinitionV1,
  type AccountSettingsStoredContentEnvelope,
  parseVoiceToolResultsFollowUp,
} from '@happier-dev/protocol';
import { buildToolResultsFollowUpPrompt } from '@/voice/context/buildVoiceToolResultsFollowUp';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionDirectToolExposedOn } from '@happier-dev/protocol/actions/actionToolExposure';
import { settingsDefaults } from '@/sync/domains/settings/settings';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { createVoiceToolHandlers, resolveVoiceToolEffectClass } = await import('./handlers');
const { resolveVoiceActionExecution } = await import('./voiceActionExecution');
const { createArtifactActionsClient } = await import('@/components/artifacts/artifactActionsClient');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

describe('Voice Action reference catalog', () => {
  beforeEach(async () => { await home.reset(); });
  afterEach(async () => { await home.reset(); });
  it('projects every public review-comment operation through the same Voice resolver and handler', () => {
    const tools = listVoiceToolActionSpecs();
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    for (const id of [
      'reviews.comments.create', 'reviews.comments.list', 'reviews.comments.get', 'reviews.comments.transition',
      'reviews.comments.edit', 'reviews.comments.reply', 'reviews.comments.redact', 'reviews.comments.setDisposition',
      'reviews.comments.attachEvidence', 'reviews.comments.bulkTransition',
    ] as const) {
      const spec = getActionSpec(id);
      const input = JSON.parse(spec.examples?.voice?.argsExample ?? '{}');
      expect(spec.inputSchema.safeParse(input).success, id).toBe(true);
      expect(tools.some(tool => tool.id === id), id).toBe(true);
      const resolved = resolveVoiceActionExecution({ actionId: id, input });
      expect(resolved?.spec.id, id).toBe(id);
      expect(handlers[resolved!.toolName], id).toBeTypeOf('function');
    }
    expect(resolveVoiceActionExecution({ actionId: 'reviews.comments.claimPublicationDispatch', input: {} })).toBeNull();
    // PLAN §3.5 intentionally excludes these operations from Voice.
    for (const id of ['session.roles.apply_to_reports', 'roles.create', 'roles.update', 'roles.delete',
      'roles.override.set', 'roles.override.reset', 'launch_profiles.publish', 'session.approval_reviewer.set'] as const) {
      expect(tools.some(tool => tool.id === id), id).toBe(false);
    }
  });
  it('reads a review comment through generic Voice and the real HTTP owner', async () => {
    const serverId = await home.addHome({ name: 'Review Voice Home', serverUrl: 'https://review-voice.test', accountId: 'alice', currentAccount: true });
    const row = buildReviewCommentFixture({ accountId: 'alice' });
    home.answer(serverId, '/v1/reviews/comments/comment-1?stored=true&includeHistory=true', {
      body: { comment: storePlainReviewCommentFixture(row) },
    });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => 'review-session', currentServerId: serverId });
    const read = JSON.parse(await handlers.action_execute!({ actionId: 'reviews.comments.get', input: { commentId: row.id } }, { serverId }));
    expect(read).toMatchObject({ ok: true, result: { comment: { id: row.id, body: row.body } } });
  });
  it('applies an empty accepted selection through generic Voice and the real HTTP owner', async () => {
    const serverId = await home.addHome({ name: 'Review apply Voice Home', serverUrl: 'https://review-apply-voice.test', accountId: 'alice', currentAccount: true });
    home.answer(serverId, '/v1/reviews/comments?sessionId=review-session&runId=review-1&includeHistory=true&limit=50&stored=true', {
      body: { items: [], cursor: null },
    });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => 'review-session', currentServerId: serverId });
    const applied = JSON.parse(await handlers.action_execute!({ actionId: 'review.apply', input: {
      sessionId: 'review-session', reviews: [{ runId: 'review-1', findings: [] }],
    } }, { serverId }));
    expect(applied).toEqual({ ok: true, result: { status: 'unchanged', commentIds: [] } });
  });
  it.each(['work.view.select', 'work.recent.show_more', 'work.map.expand'] as const)('routes %s to the Session presentation owner and refuses an unbound client', async kind => {
    const serverId = await home.addHome({ name: 'Presentation Voice Home', serverUrl: 'https://presentation-voice.test', accountId: 'alice', currentAccount: true });
    const input = { intent: { kind, ...(kind === 'work.view.select' ? { view: 'map' } : {}) } };
    expect(getActionSpec('session.presentation.apply').inputSchema.safeParse(input).success).toBe(true);
    expect(resolveVoiceActionExecution({ actionId: 'session.presentation.apply', input })?.spec.id).toBe('session.presentation.apply');
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
    expect(JSON.parse(await handlers.action_execute!({ actionId: 'session.presentation.apply', input }, { serverId })))
      .toMatchObject({ ok: false, errorCode: 'session_not_selected' });
  });
  it.each(['ui', 'voice', 'voice-disabled'] as const)('discovers a displayed Voice preference and settles its approval through %s', async decisionPath => {
    expect(isActionDirectToolExposedOn(getActionSpec('settings.list'), 'agent')).toBe(true);
    const serverId = await home.addHome({ name: 'Global Voice settings', serverUrl: 'https://global-voice-settings.test',
      accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'voice', true)).toBe(true);
    home.answer(serverId, '/v1/features', { body: features });
    let content: Extract<AccountSettingsStoredContentEnvelope, { t: 'plain' }> = {
      t: 'plain', v: { voice: { ...settingsDefaults.voice, canApproveRequests: decisionPath !== 'voice-disabled' }, favoriteMachines: ['keep-neighbor'] },
    };
    let version = 1;
    home.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content, version } }) });
    home.answer(serverId, 'POST /v2/account/settings', { select: raw => {
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (!request.content || request.content.t !== 'plain') throw new Error('Expected a plain Account fixture');
      content = request.content;
      return { body: { success: true, version: ++version } };
    } });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
    const listed = JSON.parse(await handlers.settings_list!({ pageId: 'voiceConversations' }));
    expect(listed.ok).toBe(true);
    const declaration = SettingsDeclarationActionOutputSchemasV1['settings.list'].parse({ items: listed.items }).items
      .find(item => item.title === 'Ignore sounds shorter than');
    expect(declaration).toMatchObject({ anchor: 'voiceConversations.minSpeechMs', readable: true, writable: true });
    if (!declaration) throw new Error('The displayed Voice preference was not discoverable');
    const input = { anchor: declaration.anchor };
    const before = JSON.parse(await handlers.settings_get!(input));
    expect(before).toMatchObject({ ok: true, value: 1000 });
    let created!: () => void;
    const askCreated = new Promise<void>(resolve => { created = resolve; });
    home.artifacts(serverId).afterNextCreate(async () => { created(); });
    const pending = handlers.settings_set!({ ...input, value: 1100 }, { effectId: 'global-voice-settings-write' });
    await askCreated;
    const ask = home.artifacts(serverId).list().find(row => {
      const parsed = ApprovalRequestSchema.safeParse(JSON.parse(home.artifacts(serverId).readPlainBody(row.id) ?? 'null'));
      return parsed.success && parsed.data.actionId === 'settings.set';
    });
    if (!ask) throw new Error('The model-dispatched setting must create an Ask');
    expect(version).toBe(1);
    expect(JSON.parse(await handlers.settings_get!(input))).toMatchObject({ ok: true, value: 1000 });
    expect(ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(ask.id) ?? 'null')))
      .toMatchObject({ status: 'open', actionId: 'settings.set', requestedSurface: 'voice',
        executionOriginV1: { authority: resolveInvocationAuthority({ credential: 'account', surface: 'voice',
          actionId: 'settings.set', voiceCanApproveRequests: decisionPath !== 'voice-disabled' }) } });
    // Discover the actual Account Ask through the same tools available to the
    // Voice agent; native Session updates are not its source of truth.
    const queue = JSON.parse(await handlers.approval_request_list!({ status: 'open' }));
    expect(queue.ok).toBe(true);
    expect(JSON.stringify(queue)).toContain(ask.id);
    const request = JSON.parse(await handlers.approval_request_get!({ artifactId: ask.id }));
    expect(JSON.stringify(request)).toContain('voiceConversations.minSpeechMs');
    const { ok: queueOk, ...queueBody } = queue;
    const { ok: requestOk, ...requestBody } = request;
    expect(queueOk && requestOk).toBe(true);
    const queueSchema = getActionSpec('approval.request.list').outputSchema;
    const requestSchema = getActionSpec('approval.request.get').outputSchema;
    if (!queueSchema || !requestSchema) throw new Error('Expected canonical approval output schemas');
    expect(queueSchema.parse(queueBody)).toMatchObject({
      items: [expect.objectContaining({ artifactId: ask.id, status: 'open', actionId: 'settings.set' })],
    });
    expect(requestSchema.parse(requestBody)).toMatchObject({
      artifactId: ask.id, request: { status: 'open', actionArgs: { anchor: declaration.anchor, value: 1100 } },
    });
    const results = [{ t: 'approval_request_list', args: { status: 'open' }, result: queue },
      { t: 'approval_request_get', args: { artifactId: ask.id }, result: request }];
    const privacy = { shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: true };
    const context = parseVoiceToolResultsFollowUp(buildToolResultsFollowUpPrompt(results, privacy));
    expect(JSON.stringify(context)).toContain(ask.id);
    expect(JSON.stringify(context)).toContain(requestBody.request.summary);
    // Permission sharing admits the request presentation, not its raw effect
    // operands or stored preview. The Voice policy forces tool-argument redaction.
    expect(JSON.stringify(context)).not.toContain('"actionArgs"');
    expect(JSON.stringify(context)).not.toContain('"preview"');
    const withheld = buildToolResultsFollowUpPrompt(results, { ...privacy, sharePermissionRequests: false });
    expect(withheld).not.toContain(ask.id);
    expect(withheld).not.toContain(declaration.anchor);
    if (decisionPath === 'voice-disabled') {
      const { storage } = await import('@/sync/domains/state/storage');
      storage.getState().applySettingsLocal({ voice: { ...storage.getState().settings.voice, canApproveRequests: false } });
      const refused = JSON.parse(await handlers.approval_request_decide!({ artifactId: ask.id, decision: 'approve' }));
      expect(refused).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(ask.id) ?? 'null')).status).toBe('open');
      expect(version).toBe(1);
    }
    const decided = decisionPath === 'voice'
      ? JSON.parse(await handlers.approval_request_decide!({ artifactId: ask.id, decision: 'approve' }))
      : await createDefaultActionExecutor().execute('approval.request.decide', {
        artifactId: ask.id, decision: 'approve',
      }, { surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(decided).toMatchObject({ ok: true });
    expect(JSON.parse(await pending)).toMatchObject({ ok: true, kind: 'approval_request_created', artifactId: ask.id, actionId: 'settings.set' });
    expect(JSON.parse(await handlers.settings_get!(input))).toMatchObject({ ok: true, value: 1100 });
    expect(content.v.favoriteMachines).toEqual(['keep-neighbor']);
    expect(version).toBe(2);
  });
  it('pauses an exact Workflow through generic Voice execution and the canonical Account storage owner', async () => {
    const serverId = await home.addHome({ name: 'Workflow Voice Home', serverUrl: 'https://workflow-voice.test', accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'workflows', true)).toBe(true);
    home.answer(serverId, '/v1/features', { body: features });
    const input = { runId: 'run-voice', expectedRevision: 3 };
    let revision = input.expectedRevision;
    home.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { select: operation => {
      expect(operation).toEqual({ operation: 'pause', ...input });
      revision += 1;
      return { body: WorkflowActionOutputSchemasV1['workflow.run.pause'].parse({
        run: createWorkflowRunSummaryFixture({ id: input.runId, ownerAccountId: 'alice', revision, state: 'paused' }),
        intent: 'paused',
      }) };
    } });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await handlers.action_execute!({ actionId: 'workflow.run.pause', input }, { serverId, effectId: 'pause-exact-run' }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { run: { id: input.runId, revision: 4, state: 'paused' }, intent: 'paused' } });
    expect(WorkflowActionOutputSchemasV1['workflow.run.pause'].parse(result.result)).toEqual(result.result);
    expect(revision).toBe(4);
    for (const parameters of [
      { actionId: 'workflow.run.invocations.complete_review', input: {
        runId: input.runId, invocation: { recordId: 'invocation-1' }, expectedContentRevision: '0', mode: 'use_result',
      } },
    ] as const) {
      expect(getActionSpec(parameters.actionId)
        .inputSchema.safeParse(parameters.input).success).toBe(true);
      expect(resolveVoiceActionExecution(parameters)).toBeNull();
    }
  });
  it('projects the safe target-preview and existing notice Artifact read/write Actions into Voice', () => {
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    for (const [actionId, effect] of [
      ['session.targets.resolve', 'read_only'], ['artifact.get', 'read_only'], ['artifact.update', 'mutation'],
    ] as const) {
      const tool = actionId.replaceAll('.', '_');
      expect(handlers[tool], actionId).toBeTypeOf('function');
      expect(resolveVoiceToolEffectClass(tool)).toBe(effect);
    }
  });
  it('inspects targets through the real Voice front door and publishes the canonical preview DTO', async () => {
    const serverId = await home.addHome({ name: 'Target Voice Home', serverUrl: 'https://target-preview-voice.test', accountId: 'alice', currentAccount: true });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => 'current-session' });
    const input = { actionId: 'session.message.send', target: { selector: 'self' } };
    const outcome = JSON.parse(await handlers.action_execute!({ actionId: 'session.targets.resolve', input }, { serverId }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    expect(SessionTargetPreviewV1Schema.parse(outcome.result)).toEqual({ coverage: 'complete',
      addresses: [{ serverId, sessionId: 'current-session' }], error: null });
  });
  it('reads and dismisses an owned notice through Voice and the existing approved Artifact CAS writer', async () => {
    const serverId = await home.addHome({ name: 'Notice Voice Home', serverUrl: 'https://notice-voice.test', accountId: 'alice', currentAccount: true });
    const artifacts = createArtifactActionsClient({ serverId, accountId: 'alice' });
    const created = await artifacts.createArtifact({ header: { kind: 'markdown', title: 'Notice fixture' }, body: 'Fixture' });
    if (!('ok' in created) || !created.ok) throw new Error(`Expected fixture: ${JSON.stringify(created)}`);
    const stored = home.artifacts(serverId).read(created.value.artifactId);
    if (!stored) throw new Error('Expected stored fixture');
    const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source: { kind: 'plugin', pluginId: 'acme.review', itemId: 'review-42' },
      type: 'update', resolved: false, body: 'Review updated' });
    const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: 'account_notice.v1', status: 'open', title: 'Review updated' });
    const body = JSON.stringify(content);
    // A notice written by its producer arrives across the existing Home persistence boundary.
    home.artifacts(serverId).replaceStoredRow({ ...stored, kind: undefined,
      header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body }) });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    const read = JSON.parse(await handlers.action_execute!({ actionId: 'artifact.get', input: { artifactId: stored.id } }, { serverId }));
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
    const current = ArtifactActionOutputSchemasV1['artifact.get'].parse(read.result).artifact;
    expect(current).toMatchObject({ ownerAccountId: 'alice', header: { status: 'open' } });
    if (!current) throw new Error('Expected owned notice');
    const input = { artifactId: stored.id, expectedRevision: current.revision,
      header: { ...current.header, status: 'dismissed' }, body: current.body };
    let announceCreated: () => void = () => { throw new Error('Missing creation observer'); };
    const askCreated = new Promise<void>(resolve => { announceCreated = resolve; });
    home.artifacts(serverId).afterNextCreate(async () => { announceCreated(); });
    const pending = handlers.action_execute!({ actionId: 'artifact.update', input }, { serverId, effectId: 'dismiss-notice' });
    await askCreated;
    const ask = home.artifacts(serverId).list().find(row => {
      const parsed = ApprovalRequestSchema.safeParse(JSON.parse(home.artifacts(serverId).readPlainBody(row.id) ?? 'null'));
      return parsed.success && parsed.data.actionId === 'artifact.update';
    });
    if (!ask) throw new Error('Expected notice update Ask');
    expect(ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(ask.id) ?? 'null')))
      .toMatchObject({ status: 'open', actionId: 'artifact.update', requestedSurface: 'voice', approval: { flow: 'blocking' } });
    expect(home.artifacts(serverId).read(stored.id)?.headerVersion).toBe(current.revision.headerVersion);
    const result = await createDefaultActionExecutor().execute('approval.request.decide', {
      artifactId: ask.id, decision: 'approve',
    }, { surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(JSON.parse(await pending)).toMatchObject({ ok: true, result: { artifactId: stored.id } });
    const dismissed = JSON.parse(await handlers.action_execute!({ actionId: 'artifact.get', input: { artifactId: stored.id } }, { serverId }));
    expect(ArtifactActionOutputSchemasV1['artifact.get'].parse(dismissed.result).artifact)
      .toMatchObject({ header: { status: 'dismissed', source: content.source }, body });
  });
  it('reads an admitted Doc and publishes exact reviewed Voice comments and proposals through the existing approval and C3 owners', async () => {
    const serverUrl = 'https://doc-voice.test';
    const serverId = await home.addHome({ name: 'Doc Voice Home', serverUrl, accountId: 'alice', currentAccount: true });
    const artifacts = createArtifactActionsClient({ serverId, accountId: 'alice' });
    const source = 'Private first passage.\n\nPrivate second passage.';
    const created = await artifacts.createArtifact({ header: { kind: 'markdown', title: 'Voice notes' }, body: source });
    if (!('ok' in created) || !created.ok) throw new Error(`Expected source Doc: ${JSON.stringify(created)}`);
    const ref = { kind: 'doc' as const, artifactId: created.value.artifactId, serverId };
    const network = answerDiscussionThreadForTests(home, serverId, { loseCreate: false, loseFirstRejoin: false });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(handlers.doc_read).toBeTypeOf('function');
    expect(resolveVoiceToolEffectClass('doc_read')).toBe('read_only');
    const read = JSON.parse(await handlers.action_execute!({ actionId: 'doc.read', input: { ref } }, { serverId }));
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
    const admitted = DocReadResultV1Schema.parse(read.result);
    expect(admitted).toMatchObject({ ref, artifact: { body: source, revision: created.value.revision }, openCommentCount: 0 });
    const target = captureDocPassageV1({ ref, revision: admitted.artifact.revision, source,
      range: { start: source.lastIndexOf('Private'), end: source.length } });
    await home.requireActionApproval(serverId, ['doc.comment.reply', 'doc.edit.propose'], 'voice');
    const requests = [
      { actionId: 'doc.comment.reply', input: { target, localId: 'voice-comment', content: { v: 1,
        parts: [{ t: 'text', text: 'Please clarify the second passage.' }] } } },
      { actionId: 'doc.edit.propose', input: { target, discussionRef: { serverId, discussionId: 'committed-thread' },
        localId: 'voice-proposal', baseRevision: target.revision, before: target.quote,
        after: 'A clearer second passage.', reason: 'Make the exact passage explicit.' } },
    ] as const;
    const executor = createDefaultActionExecutor();
    for (const { actionId, input } of requests) {
      expect(resolveVoiceActionExecution({ actionId, input })?.input).toEqual(input);
      expect(resolveVoiceToolEffectClass(actionId.replaceAll('.', '_'))).toBe('mutation');
      const before = network.messages.length;
      const pending = JSON.parse(await handlers.action_execute!({ actionId, input }, { serverId, effectId: input.localId }));
      expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(JSON.stringify(pending)).not.toContain(target.quote);
      expect(network.messages).toHaveLength(before);
      const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(pending.result.artifactId) ?? 'null'));
      expect(request).toMatchObject({ actionId, actionArgs: input, status: 'open', requestedSurface: 'voice',
        preview: { actionId, actionArgs: input }, executionOriginV1: { surface: 'voice', authority: resolveInvocationAuthority({
          credential: 'account', surface: 'voice', actionId, voiceCanApproveRequests: settingsDefaults.voice.canApproveRequests,
        }) } });
      const presentation = describeApprovalActionFields(request);
      expect(presentation.unrepresentable).toBeNull();
      expect(presentation.rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target', value: JSON.stringify(target) })]));
      if (actionId === 'doc.edit.propose') for (const field of ['before', 'after', 'reason'] as const) {
        expect(presentation.rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: field, value: input[field] })]));
      }
      const decided = await executor.execute('approval.request.decide', { artifactId: pending.result.artifactId, decision: 'approve' }, {
        surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' },
      });
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(network.messages).toHaveLength(before + 1);
    }
    expect(network.messages[0]?.content).toEqual({ t: 'plain', v: { kind: 'doc_passage_comment', passage: target, content: requests[0].input.content } });
    expect(network.messages[1]?.content).toEqual({ t: 'plain', v: { kind: 'doc_edit_proposal', proposal: {
      target, baseRevision: target.revision, before: target.quote, after: requests[1].input.after, reason: requests[1].input.reason,
    } } });
    const canceledInput = { ...requests[0].input, localId: 'voice-canceled-comment' };
    const pending = JSON.parse(await handlers.action_execute!({ actionId: 'doc.comment.reply', input: canceledInput }, {
      serverId, effectId: canceledInput.localId,
    }));
    expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await executor.execute('approval.request.decide', { artifactId: pending.result.artifactId, decision: 'cancel' }, {
      surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { status: 'canceled' } });
    expect(network.messages).toHaveLength(2);
    expect(home.artifacts(serverId).readPlainBody(ref.artifactId)).toContain(source);
  });
  it('keeps refused, canceled and person-only Doc Voice calls free of source previews or effects', async () => {
    const serverId = await home.addHome({ name: 'Refused Doc Home', serverUrl: 'https://doc-voice-refusal.test', accountId: 'alice', currentAccount: true });
    const ref = { kind: 'doc' as const, artifactId: 'unavailable-doc', serverId };
    const target = { ref, revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 13 }, quote: 'Private quote' };
    const input = { target, localId: 'must-not-post', content: { v: 1, parts: [{ t: 'text', text: 'Private comment' }] } };
    home.answer(serverId, `/v1/artifacts/${ref.artifactId}`, { status: 403, body: { error: 'artifact_access_forbidden' } });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(handlers.doc_read).toBeTypeOf('function');
    const refused = await handlers.action_execute!({ actionId: 'doc.read', input: { ref } }, { serverId });
    expect(JSON.parse(refused), refused).toMatchObject({ ok: false });
    expect(refused).not.toContain(target.quote);
    const before = home.requests.length;
    const canceled = new AbortController();
    canceled.abort();
    expect(JSON.parse(await handlers.doc_read!({ ref }, { serverId, signal: canceled.signal })))
      .toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    expect(home.requests).toHaveLength(before);
    const foreign = JSON.parse(await handlers.action_execute!({ actionId: 'doc.read', input: { ref: { ...ref, serverId: 'foreign-home' } } }, { serverId }));
    expect(foreign).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    for (const parameters of [
      { actionId: 'doc.comment.reply', input: { ...input, bypassApprovals: true, authority: 'present_user' } },
      { actionId: 'doc.edit.propose', input: { target, localId: 'invalid-basis', discussionRef: { serverId, discussionId: 'thread' },
        baseRevision: { headerVersion: 1, bodyVersion: 2 }, before: target.quote, after: 'Replacement', reason: 'Reason' } },
      { actionId: 'doc.edit.accept', input: { proposalRef: { kind: 'discussion', discussion: { serverId, discussionId: 'thread' }, messageId: 'proposal' },
        expectedRevision: target.revision } },
      { actionId: 'doc.edit.decline', input: { proposalRef: { kind: 'discussion', discussion: { serverId, discussionId: 'thread' }, messageId: 'proposal' } } },
    ]) {
      const result = await handlers.action_execute!(parameters, { serverId, effectId: 'must-not-create-preview' });
      expect(JSON.parse(result), result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(result).not.toContain(target.quote);
    }
    expect(handlers.doc_edit_accept).toBeUndefined();
    expect(handlers.doc_edit_decline).toBeUndefined();
    expect(home.requestsFor(`/v1/artifacts/${ref.artifactId}`)).toHaveLength(1);
    expect(home.requestsFor('/v1/discussions')).toEqual([]);
    expect(home.artifacts(serverId).list()).toEqual([]);
  });
  it.each([
    ['follow.get', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'exact-source' } }],
    ['follow.set', { receiver: { kind: 'session', sessionId: { selector: 'self' } }, source: { kind: 'session', sessionId: 'exact-source' }, policy: { preset: 'important' } }],
    ['follow.remove', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'exact-source' } }],
    ['follow.list', { direction: 'following', receiver: { kind: 'account' } }],
    ['follow.preview', { receiver: { kind: 'account' }, filter: {
      show: 'sessions', startedBy: ['you'], scope: 'all_accessible', attention: 'any',
      homeServerIds: ['home'], audiences: [], tagIds: [], source: 'all',
    } }],
    ['follow.preferences.get', {}],
    ['follow.preferences.set', { assigned: true, direct: false, team: false, group: false }],
    ['session.message.reply', { sessionId: { selector: 'self' }, requestLocalId: 'original-input', reply: { kind: 'pass' } }],
    ['session.handoff', { sessionId: 'exact-session', targetMachineId: 'exact-machine', stateTransfer: 'existing', workspaceAction: { kind: 'none' } }],
    ['session.update.post', { summary: 'A persisted update' }],
    ['inbox.get', {}],
    ['inbox.mark_all_read', { targets: [] }],
    ['session.trigger.list', { sessionId: 'exact-session' }],
    ['workflow.trigger.list', { workflow: 'builtin:review-and-converge' }],
    ['workflow.run.list', { targetSessionId: 'exact-session' }],
    ['session.read_state.set', { sessionId: 'exact-session', state: 'read' }],
    ['session.attention.set', { sessionId: 'exact-session', standing: false }],
    ['session.manager.set', { sessionId: 'exact-worker', managerSessionId: 'exact-manager', expectedManagerSessionId: null }],
  ] as const)('resolves generic Voice execution of %s without changing its exact operands', (actionId, input) => {
    const resolved = resolveVoiceActionExecution({ actionId, input });
    expect(resolved?.spec.id).toBe(actionId);
    expect(resolved?.input).toEqual(input);
    expect(resolved?.toolName).toBe(actionId.replaceAll('.', '_'));
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(handlers[actionId.replaceAll('.', '_')]).toBeTypeOf('function');
  });
  it.each([
    { managerSessionId: 'exact-manager', expectedManagerSessionId: null },
    { managerSessionId: null, expectedManagerSessionId: 'exact-manager' },
  ])('retains manager Voice operands and approval before attachment changes ($managerSessionId)', async operands => {
    const serverUrl = 'https://manager-voice.test';
    const serverId = await home.addHome({ name: 'Manager Home', serverUrl, accountId: 'account-a', currentAccount: true });
    const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a',
      credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
      request: (url, init) => home.request(url, init) });
    try {
      await home.requireActionApproval(serverId, 'session.manager.set', 'voice');
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(resolveVoiceToolEffectClass('session_manager_set')).toBe('mutation');
      const input = { sessionId: 'exact-worker', ...operands };
      const result = JSON.parse(await handlers.action_execute!({ actionId: 'session.manager.set', input }, {
        serverId, effectId: operands.managerSessionId === null ? 'voice-manager-detach' : 'voice-manager-attach',
      }));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const approvals = home.artifacts(serverId).list().map(row => ApprovalRequestSchema.parse(
        JSON.parse(home.artifacts(serverId).readPlainBody(row.id) ?? 'null'),
      ));
      expect(approvals).toEqual([expect.objectContaining({ actionId: 'session.manager.set', actionArgs: input, status: 'open' })]);
      expect(home.requests.filter(request => request.path === '/v1/sessions/exact-worker/manager')).toEqual([]);
    } finally {
      await connection.dispose();
      installHomeGovernanceBoundaries(home);
    }
  });
  it.each(['session.read_state.set', 'session.attention.set'] as const)(
    'dispatches %s from Voice with private Account authority and exact Home', async actionId => {
      const serverUrl = 'https://attention-voice.test';
      const serverId = await home.addHome({ name: 'Attention Home', serverUrl, accountId: 'account-a', currentAccount: true });
      const path = actionId === 'session.read_state.set'
        ? '/v2/sessions/exact-session/read-state'
        : '/v2/session-organization/attention-standings/exact-session';
      const method = actionId === 'session.read_state.set' ? 'POST' : 'PUT';
      const body = actionId === 'session.read_state.set' ? { state: 'read' } : { standing: false };
      home.answer(serverId, `${method} ${path}`, { body: actionId === 'session.read_state.set'
        ? { success: true, state: 'read', lastViewedSessionSeq: 7, didChange: true }
        : { standing: { sessionId: 'exact-session', standing: false, updatedAt: 10 } } });
      const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
        request: (url, init) => home.request(url, init) });
      try {
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        const handler = handlers.action_execute;
        expect(handler).toBeTypeOf('function');
        const result = JSON.parse(await handler!({ actionId, input: { sessionId: 'exact-session', ...body } }, { serverId }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        const request = home.requests.find(request => request.path === path);
        expect(request).toMatchObject({ serverId, input: body, token: connection.credentials.token });
        expect(getActionSpec(actionId).requiredAuthority).toBe('account_automation');
      } finally {
        await connection.dispose();
        installHomeGovernanceBoundaries(home);
      }
    });
  it('routes Workflow start Voice input through the canonical Action schema and mutation custody', async () => {
    const serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow-voice.test', accountId: 'account-a', currentAccount: true });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    const handler = handlers.workflow_run_start;
    expect(handler).toBeTypeOf('function');
    expect(resolveVoiceToolEffectClass('workflow_run_start')).toBe('mutation');
    expect(JSON.parse(await handler!({ runId: 'not-a-uuid', source: {} }, { effectId: 'voice-workflow-start', serverId })))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it.each(['localServices_actions_copyUrl'] as const)(
    'does not advertise %s when the permission receipt has no answering clipboard or navigation client', toolName => {
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(handlers[toolName]).toBeUndefined();
    });
  it.each(['localServices_launcher_start', 'localServices_actions_stopManaged', 'localServices_actions_openPreview'] as const)(
    'routes %s through the actual Action input boundary and retains mutation custody classification', async toolName => {
      // The front door captures an actual signed-in Home before dispatch.
      // Seed its credential/network boundaries, not an internal executor.
      const serverId = await home.addHome({ name: 'Service Home', serverUrl: 'https://service-home.test', accountId: 'account-a', currentAccount: true });
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      const handler = handlers[toolName];
      expect(handler).toBeTypeOf('function');
      expect(resolveVoiceToolEffectClass(toolName)).toBe('mutation');
      // No internal Action executor replacement: invalid semantic input must
      // settle before a Machine effect can occur, even without a selected Session.
      expect(JSON.parse(await handler!({}, { effectId: 'voice-service-effect', serverId })))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
  it('composes current contributed Actions into the existing action.spec tools', async () => {
    const contributedAction: ActionDefinitionV1 = {
      kindVersion: 1,
      id: formatQualifiedPluginActionId({ pluginId: 'acme.triage', localId: 'file-ticket' }),
      title: 'File ticket',
      description: 'Files a ticket for the selected issue.',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: true,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    };
    const handlers = createVoiceToolHandlers({
      resolveSessionId: () => null,
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => undefined,
        listCurrentContributedActionDefinitions: () => [contributedAction],
      },
    });
    const searchToolName = getActionSpec('action.spec.search').bindings?.voiceClientToolName;
    if (!searchToolName) throw new Error('missing action.spec.search Voice binding');

    const result = JSON.parse(await handlers[searchToolName]!({ query: 'file ticket' }));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.actionSpecs).toContainEqual(expect.objectContaining({
      id: contributedAction.id,
      title: contributedAction.title,
    }));
  });
});
