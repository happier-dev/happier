import { describe, expect, it } from 'vitest';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1.js';
import { projectApprovalRequestForPublicRead } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';

const queryPlan = {
  kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore',
  boundedBy: 'approval artifact id', hydratedTranscripts: false,
};

describe('public approval read schema', () => {
  it('reads the identity-only skill acknowledgment already persisted by older observation projection', () => {
    const result = { ok: true, skillId: 'review', revision: '1:1' };
    expect(getActionSpec('skills.create').outputSchema.safeParse(result).success).toBe(true);
  });

  it('preserves the saved skill acknowledgment through deferred completion and public observation', () => {
    const result = getActionSpec('skills.create').outputSchema.parse({
      ok: true, skillId: 'review', revision: '1:1', includedInSessionId: 'bot',
      summary: { name: 'Review', description: 'Review changes', creator: { kind: 'agent', accountId: 'owner', sessionId: 'bot' } },
      inclusion: { ok: false, code: 'applies_to_new_sessions_only' }, incomplete: 'session_include',
    });
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'agent', sessionId: 'bot' },
      actionId: 'skills.create', actionArgs: { name: 'Review', files: [] }, summary: 'Create skill',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result },
    });
    const observed = projectApprovalRequestForPublicRead(request);
    expect(getActionSpec('approval.request.get').outputSchema.safeParse({ artifactId: 'approval', request: observed, canAllow: false, queryPlan }).success).toBe(true);
    expect(observed).toMatchObject({ execution: { result } });
  });

  it.each([
    {},
    { installOn: [] },
    { installOn: ['machine'] },
  ])('reads registry install approval with optional targets %j', targets => {
    const actionArgs = getActionSpec('agents.acp.backends.installFromRegistry').inputSchema.parse({
      fromRegistry: { sourceId: 'acp-registry', itemId: 'codex-acp', version: '2.2.2' }, ...targets,
    });
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' },
      actionId: 'agents.acp.backends.installFromRegistry', actionArgs, summary: 'Install agent',
    });
    const result = { artifactId: 'approval', request: projectApprovalRequestForPublicRead(request), canAllow: false, queryPlan };
    expect(getActionSpec('approval.request.get').outputSchema.parse(result)).toEqual(result);
    expect(result.request).toMatchObject({ actionArgs });
  });

  it.each([
    { status: 'unavailable', reason: 'catalog_unavailable' },
    { status: 'invalid', reason: 'entry_not_found' },
    { status: 'updated', revision: 2 },
  ])('reads account instruction approval receipt %j', output => {
    const actionArgs = getActionSpec('prompts.stack.update').inputSchema.parse({
      surface: 'coding', expectedRevision: 'absent', intent: { kind: 'detach', entryId: 'entry' },
    });
    const result = getActionSpec('prompts.stack.update').outputSchema.parse(output);
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' },
      actionId: 'prompts.stack.update', actionArgs, summary: 'Update instructions',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result },
    });
    const publicResult = { artifactId: 'approval', request: projectApprovalRequestForPublicRead(request), canAllow: false, queryPlan };
    expect(getActionSpec('approval.request.get').outputSchema.parse(publicResult)).toEqual(publicResult);
    expect(publicResult.request).toMatchObject({ execution: { result: { status: output.status } } });
  });

  it.each(['requester', null])('retains existing attribution for requester %s through the Action result schema', accountId => {
    const attribution = { requestRef: 'input', requester: accountId ? { serverId: 'home', accountId } : null,
      persona: { serverId: 'home', sessionId: 'bot' }, origin: null };
    const executionOriginV1 = {
      v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', actionId: 'session.title.set', requestId: 'request',
      actionRequestAttributionV1: attribution, externalActionInputSignature: 'a'.repeat(86),
    };
    const base = {
      status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 2, decidingAccountId: 'private-decider' },
      execution: { executedAtMs: 3, ok: true, result: { changed: true } },
    };
    const builtIn = ApprovalRequestV2Schema.parse({ ...base, v: 2, executionOriginV1,
      actionId: 'session.title.set', actionArgs: { sessionId: 'bot', title: 'Release' },
      origin: { kind: 'transcript_tool_call', sessionId: 'bot', toolName: 'title', toolInput: { private: 'raw-input' } },
    });
    const target = TargetActionApprovalRequestV1Schema.parse({ ...base, v: 1, kind: 'plugin_target_action',
      qualifiedActionId: 'acme.titles/actions/set', input: { title: 'Release', credential: 'private-input' },
      secretInputPaths: ['credential'], sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
      executionOriginV1: { ...executionOriginV1, actionId: 'action.invoke' },
    });
    const schema = getActionSpec('approval.request.get').outputSchema;
    for (const request of [builtIn, target]) {
      const publicRead = projectApprovalRequestForPublicRead(request);
      const result = { artifactId: 'approval', request: publicRead, canAllow: false, queryPlan };
      expect(schema.parse(result)).toEqual(result);
      expect(publicRead).toMatchObject({ executionOriginV1: { actionRequestAttributionV1: attribution } });
      expect(schema.safeParse({ ...result, request }).success).toBe(false);
      const serialized = JSON.stringify(publicRead);
      for (const privateValue of ['private-decider', 'raw-input', 'private-input', 'externalActionInputSignature']) {
        expect(serialized).not.toContain(privateValue);
      }
      if ('actionArgs' in request && publicRead && typeof publicRead === 'object') {
        expect(schema.safeParse({ ...result, request: { ...publicRead, actionArgs: { callback: () => undefined } } }).success).toBe(false);
      }
    }
  });

  it('reads sanitized V1 history without admitting its preserved unknown custody fields', () => {
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' },
      actionId: 'session.list', actionArgs: {}, summary: 'List', privateRequester: 'private-person',
      decision: { kind: 'approve', decidedAtMs: 2, decidingAccountId: 'private-decider', decidedVia: 'voice' },
      execution: { executedAtMs: 3, ok: true, result: { count: 1 }, privateReceipt: 'private-receipt' },
    });
    const publicRead = projectApprovalRequestForPublicRead(request);
    const result = { artifactId: 'approval', request: publicRead, canAllow: false, queryPlan };
    const schema = getActionSpec('approval.request.get').outputSchema;
    expect(schema.parse(result)).toEqual(result);
    expect(schema.safeParse({ ...result, request }).success).toBe(false);
    expect(publicRead).toMatchObject({ decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { count: 1 } } });
    expect(publicRead).not.toHaveProperty('privateRequester');
    expect(publicRead).not.toHaveProperty('decision.decidedVia');
    expect(JSON.stringify(publicRead)).not.toContain('private-');
  });
});
