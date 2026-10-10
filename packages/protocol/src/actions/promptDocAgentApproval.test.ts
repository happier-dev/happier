import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createPromptDocInLibrary, updatePromptDocInLibrary, readPromptDocInLibrary, type PromptLibraryArtifactStore } from '../prompts/library/promptLibraryActionOperations.js';
import { PromptDocBodyV1Schema } from '../prompts/library/promptDocV2.js';

// Artifact custody and document persistence are the real external storage boundaries.
function harness() {
  let markdown = 'Now: investigate';
  let revision = { headerVersion: 1, bodyVersion: 1 };
  let approval: ApprovalRequest | null = null;
  let created = 0;
  const store: PromptLibraryArtifactStore = {
    create: async () => { created += 1; return 'created'; },
    read: async (artifactId) => artifactId === 'memory' ? {
      id: artifactId, revision, header: { v: 1, kind: 'prompt_doc.v2', title: 'Memory' },
      body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }),
    } : null,
    update: async ({ body, expectedRevision }) => {
      if (expectedRevision.headerVersion !== revision.headerVersion || expectedRevision.bodyVersion !== revision.bodyVersion) {
        throw Object.assign(new Error('artifact_version_mismatch'), { code: 'version_mismatch' });
      }
      markdown = PromptDocBodyV1Schema.parse(JSON.parse(body)).markdown;
      revision = { headerVersion: revision.headerVersion + 1, bodyVersion: revision.bodyVersion + 1 };
    },
  };
  const empty = async () => ({});
  const inventory = async () => ({ items: [] });
  const deps: ActionExecutorDeps = {
    executionRunStart: empty, executionRunList: empty, executionRunGet: empty,
    detachedExecutionRunSend: empty, executionRunStop: empty, executionRunAction: empty,
    executionRunWait: empty, sessionOpen: empty, sessionFork: empty, sessionRollback: empty,
    sessionSpawnNew: empty, pathsListRecent: inventory, machinesList: inventory,
    serversList: inventory, reviewEnginesList: inventory, agentsBackendsList: inventory,
    agentsModelsList: inventory, sessionSendMessage: empty, sessionPermissionRespond: empty,
    sessionUserActionAnswer: empty, sessionTargetPrimarySet: empty, sessionTargetTrackedSet: empty,
    sessionList: empty, sessionActivityGet: empty, sessionRecentMessagesGet: empty,
    daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: empty, resetGlobalVoiceAgent: async () => {},
    approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'approval' }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }) => {
      approval = request;
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
    promptDocUpdate: async ({ signal, ...request }) => updatePromptDocInLibrary({ store, request, signal }),
    promptDocGet: async ({ artifactId, signal }) => readPromptDocInLibrary({ store, artifactId, signal }),
    promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }),
  };
  return { executor: createActionExecutor(deps), read: () => ({ markdown, approval, created }) };
}

describe('workstream memory document Agent approval', () => {
  it('settles a stale reviewed approval as conflict while retaining the newer document', async () => {
    const { executor, read } = harness();
    const agent = { surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'reviewed-proposal' } as const;
    const preview = await executor.execute('prompt_doc.get', { artifactId: 'memory' }, agent);
    expect(preview).toMatchObject({ ok: true, result: { revision: { headerVersion: 1, bodyVersion: 1 } } });
    await executor.execute('prompt_doc.update', { artifactId: 'memory', title: 'Memory', markdown: 'Reviewed proposal',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, agent);
    const human = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
    await executor.execute('prompt_doc.update', { artifactId: 'memory', title: 'Memory', markdown: 'Newer content' }, human);
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, human);
    expect(read()).toMatchObject({ markdown: 'Newer content', approval: { status: 'failed',
      execution: { ok: false, errorCode: 'version_mismatch' } } });
  });

  it('requires approval for agent creation and creates exactly once after approval', async () => {
    const { executor, read } = harness();
    const result = await executor.execute('prompt_doc.create', { title: 'Saved', markdown: 'Verbatim', favorite: true },
      { surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'create-proposal' });
    expect(result.ok).toBe(true);
    expect(read()).toMatchObject({ created: 0, approval: { status: 'open', actionId: 'prompt_doc.create' } });
    const context = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
    expect((await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context)).ok).toBe(true);
    expect(read()).toMatchObject({ created: 1, approval: { status: 'executed' } });
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context);
    expect(read().created).toBe(1);
  });
  it('keeps a proposal pending until approved, then executes it once', async () => {
    const { executor, read } = harness();
    const result = await executor.execute('prompt_doc.update', {
      artifactId: 'memory', title: 'Workstream memory', markdown: 'Done: investigation',
    }, { surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'proposal' });
    expect(result.ok).toBe(true);
    expect(read()).toMatchObject({ markdown: 'Now: investigate', approval: {
      status: 'open', actionId: 'prompt_doc.update', actionArgs: { artifactId: 'memory', markdown: 'Done: investigation' },
    } });
    const context = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
    expect((await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context)).ok).toBe(true);
    expect(read()).toMatchObject({ markdown: 'Done: investigation', approval: { status: 'executed' } });
    await executor.execute('prompt_doc.update', { artifactId: 'memory', title: 'Memory', markdown: 'Next: user edit' }, context);
    expect((await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context)).ok).toBe(true);
    expect(read()).toMatchObject({ markdown: 'Next: user edit', approval: { status: 'executed' } });
  });

  it('rejects a proposal without modifying the document; the user edits directly', async () => {
    const { executor, read } = harness();
    const request = { artifactId: 'memory', title: 'Memory', markdown: 'Proposed change' };
    await executor.execute('prompt_doc.update', request, { surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'proposal' });
    const context = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'reject' }, context);
    expect(read()).toMatchObject({ markdown: 'Now: investigate', approval: { status: 'rejected' } });
    expect((await executor.execute('prompt_doc.update', request, context)).ok).toBe(true);
    expect(read().markdown).toBe('Proposed change');
  });

  it('reads the current memory by Artifact reference, including an approved update', async () => {
    const { executor } = harness();
    const agent = { surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'proposal' } as const;
    expect(await executor.execute('prompt_doc.get', { artifactId: 'memory' }, agent)).toMatchObject({
      ok: true, result: { artifactId: 'memory', markdown: 'Now: investigate' },
    });
    await executor.execute('prompt_doc.update', { artifactId: 'memory', title: 'Memory', markdown: 'Approved learning' }, agent);
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home',
    });
    expect(await executor.execute('prompt_doc.get', { artifactId: 'memory' }, agent)).toMatchObject({
      ok: true, result: { artifactId: 'memory', markdown: 'Approved learning' },
    });
    expect(await executor.execute('prompt_doc.get', { artifactId: 'missing' }, agent)).toMatchObject({
      ok: false, errorCode: 'prompt_doc_not_found',
    });
  });
});
