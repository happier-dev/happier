import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from './approvalRequestV1.js';
import {
  approvalArtifactBodyMatchesHeaderV1,
  readApprovalArtifactAdmissionV1,
  buildApprovalRequestArtifactHeaderV1,
  buildExecutionRunHostActionApprovalArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
  deriveManagedDeleteApprovalSubjectKeyV1,
  listApprovalArtifactsV1,
  managedDeleteApprovalIndexedKindV1,
} from './approvalArtifactHeaderV1.js';
import { ExecutionRunHostActionApprovalRequestV1Schema } from './executionRunHostActionApprovalRequestV1.js';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1.js';
import { listArtifactHeadersV1 } from '../artifacts/artifactListSelectionV1.js';
import { deriveArtifactStoredKindV1 } from '../artifacts/artifactKindV1.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { projectWorkflowDiscussionProducerV1 } from '../workflows/workflowDiscussionPublicationV1.js';

describe('approval Artifact header correspondence', () => {
  const builtIn = ApprovalRequestV2Schema.parse({
    v: 2,
    status: 'executing',
    createdAtMs: 1,
    updatedAtMs: 2,
    createdBy: { surface: 'agent', sessionId: 'session-1' },
    requestedSurface: 'agent',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'agent',
      caller: { kind: 'host' },
      serverId: 'profile-1',
      serverIdentityId: 'server-identity-1',
      accountId: 'account-1',
      sessionId: 'session-1',
      machineId: 'machine-1',
      runId: 'run-1',
      runOccurrenceId: 'occurrence-1',
      actionId: 'session.title.set',
      requestId: 'request-1',
    },
    actionId: 'session.title.set',
    actionArgs: { sessionId: 'session-1', title: 'Approved' },
    summary: 'Set title',
    decision: { kind: 'approve', decidedAtMs: 2 },
  });

  const target = TargetActionApprovalRequestV1Schema.parse({
    v: 1,
    kind: 'plugin_target_action',
    status: 'executing',
    createdAtMs: 1,
    updatedAtMs: 2,
    createdBy: { surface: 'system' },
    requestedSurface: 'api',
    qualifiedActionId: 'acme.publisher/actions/releases/publish',
    input: {},
    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
    policyFingerprint: 'a'.repeat(64),
    subjectFingerprint: 'b'.repeat(64),
    replayPlacement: { serverId: 'profile-1', machineId: 'machine-1', defaultSessionId: 'session-1' },
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'api',
      caller: { kind: 'host' },
      serverId: 'profile-1',
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      sessionId: 'session-1',
      machineId: 'machine-1',
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'action.invoke',
      requestId: 'request-1',
    },
    summary: 'Publish',
    decision: { kind: 'approve', decidedAtMs: 2 },
  });

  it('indexes Workflow Run custody separately from Automation run ids and admits older headers', () => {
    const request = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      executionOriginV1: { ...builtIn.executionOriginV1, caller: { kind: 'workflowRun', runId: 'workflow-a',
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } } });
    const external = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify({ ...target, status: 'open', decision: undefined,
      executionOriginV1: { ...target.executionOriginV1, caller: request.executionOriginV1.caller } })));
    for (const [value, header] of [[request, buildApprovalRequestArtifactHeaderV1(request)],
      [external, buildTargetActionApprovalArtifactHeaderV1(external)]] as const) {
      expect(header.workflowRunId).toBe('workflow-a');
      expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(value))?.request).toEqual(value);
      expect(approvalArtifactBodyMatchesHeaderV1({ ...header, workflowRunId: 'workflow-b' }, JSON.stringify(value))).toBeNull();
      const { workflowRunId: _relation, ...legacy } = header;
      expect(approvalArtifactBodyMatchesHeaderV1(legacy, JSON.stringify(value))?.request).toEqual(value);
    }
    expect(buildApprovalRequestArtifactHeaderV1(builtIn).workflowRunId).toBeNull();
    expect(buildTargetActionApprovalArtifactHeaderV1(target).workflowRunId).toBeNull();
    const automation = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      executionOriginV1: { ...builtIn.executionOriginV1, runId: 'automation-run-1',
        caller: { kind: 'automationRun', runId: 'automation-run-1', automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } } } });
    expect(buildApprovalRequestArtifactHeaderV1(automation)).toMatchObject({ runId: 'automation-run-1', workflowRunId: null });
  });

  it('indexes Project Start source custody before hydration, and verifies supplied index facts against the body', () => {
    const workspace = { serverId: 'home', machineId: 'source', workspaceId: 'checkout', rootPath: '/source' };
    const start = ApprovalRequestV2Schema.parse({ ...builtIn, actionId: 'localServices.launcher.start',
      executionOriginV1: { ...builtIn.executionOriginV1, actionId: 'localServices.launcher.start', machineId: 'worker' },
      actionArgs: { machineId: 'worker', targetId: 'web', workspace,
        declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } } } });
    const header = buildApprovalRequestArtifactHeaderV1(start);
    expect(header.approvalSubjectKey).toEqual(expect.stringMatching(/^project-service-start:/));
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(start))?.family).toBe('built_in');
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, approvalSubjectKey: 'project-service-start:other' }, JSON.stringify(start))).toBeNull();
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, approvalSubjectKey: { machineId: 'source' } }, JSON.stringify(start))).toBeNull();
    const { approvalSubjectKey: _index, ...previousHeader } = header;
    expect(approvalArtifactBodyMatchesHeaderV1(previousHeader, JSON.stringify(start))?.family).toBe('built_in');
    expect(buildApprovalRequestArtifactHeaderV1({ ...start, actionArgs: { ...start.actionArgs as object, declaration: undefined } }).approvalSubjectKey).toBeUndefined();
  });

  it('resumes a bounded approval page and filters plugin approvals through their canonical Action id', async () => {
    const rows = [
      { artifactId: 'built-in', updatedAt: 2, header: buildApprovalRequestArtifactHeaderV1(builtIn), body: JSON.stringify(builtIn) },
      { artifactId: 'plugin-target', updatedAt: 1, header: buildTargetActionApprovalArtifactHeaderV1(target), body: JSON.stringify(target) },
    ];
    // The persistent Artifact page is the boundary; correspondence and queue
    // projection use the production reader and real schema-built bodies.
    const readPage = async ({ limit, cursor }: { limit: number; cursor?: string }) => {
      const start = cursor ? rows.findIndex(row => row.artifactId === cursor) + 1 : 0;
      const items = rows.slice(start, start + limit);
      return { items, ...(start + items.length < rows.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
    };
    const store = { readPage, read: async () => null };
    const first = await listApprovalArtifactsV1({ ...store, limit: 1 });
    expect(first.items.map(item => item.artifactId)).toEqual(['built-in']);
    expect(first.nextCursor).toBe('built-in');
    const second = await listApprovalArtifactsV1({ ...store, limit: 1, cursor: first.nextCursor });
    expect(second.items.map(item => item.artifactId)).toEqual(['plugin-target']);
    expect(second.nextCursor).toBeNull();
    const outputSchema = getActionSpec('approval.request.list').outputSchema;
    expect(outputSchema.parse(first)).toEqual(first);
    expect(outputSchema.parse(second)).toEqual(second);
    const filtered = await listApprovalArtifactsV1({ ...store, limit: 1, actionId: 'action.invoke' });
    expect(filtered.items.map(item => item.artifactId)).toEqual(['plugin-target']);
  });

  it('filters target-bound approval reads by the body-authoritative Session', async () => {
    const other = ApprovalRequestV2Schema.parse({
      ...builtIn,
      createdBy: { surface: 'agent', sessionId: 'session-2' },
      executionOriginV1: { ...builtIn.executionOriginV1, sessionId: 'session-2',
        target: { kind: 'session', sessionId: 'session-2' } },
      actionArgs: { sessionId: 'session-2', title: 'Other' },
    });
    const rows = [
      { artifactId: 'selected', updatedAt: 2, header: buildApprovalRequestArtifactHeaderV1(builtIn), body: JSON.stringify(builtIn) },
      { artifactId: 'other', updatedAt: 1, header: buildApprovalRequestArtifactHeaderV1(other), body: JSON.stringify(other) },
    ];
    const result = await listApprovalArtifactsV1({ sessionId: 'session-1', limit: 10,
      readPage: async () => ({ items: rows }), read: async () => null });
    expect(result.items.map(item => item.artifactId)).toEqual(['selected']);
  });

  it('requires authoritative Session locality instead of the approval execution placement', async () => {
    let subjectMachineId: string | null = 'machine-2';
    const list = () => listApprovalArtifactsV1({
      targetGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: ['machine-1'] } },
      resolveSessionMachineId: async () => subjectMachineId,
      readPage: async () => ({ items: [{ artifactId: 'subject', updatedAt: 2,
        header: buildApprovalRequestArtifactHeaderV1(builtIn), body: JSON.stringify(builtIn) }] }),
      read: async () => null,
    });
    expect((await list()).items).toEqual([]);
    subjectMachineId = null;
    expect((await list()).items).toEqual([]);
    subjectMachineId = 'machine-1';
    expect((await list()).items.map(item => item.artifactId)).toEqual(['subject']);
  });

  it('admits moved Sessions before hydration using current locality, not recorded execution placement', async () => {
    const moved = ApprovalRequestV2Schema.parse({ ...builtIn,
      executionOriginV1: { ...builtIn.executionOriginV1, machineId: 'machine-old' },
    });
    const row = { artifactId: 'moved', createdAt: 1, updatedAt: 2,
      header: buildApprovalRequestArtifactHeaderV1(moved) };
    let currentMachineId: string | null = 'machine-current';
    const hydrated: string[] = [];
    const resolveSessionMachineId = vi.fn(async () => currentMachineId);
    const list = () => listApprovalArtifactsV1({
      targetGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: ['machine-current'] } },
      resolveSessionMachineId,
      readPage: options => listArtifactHeadersV1({ options, encodeCursor: item => item.artifactId,
        readPage: async () => ({ items: [row], kindCoverage: { status: 'complete', unclassifiedCount: 0 } }),
        readBodies: async items => {
          hydrated.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: JSON.stringify(moved) }));
        },
      }),
      read: async () => { throw new Error('Unexpected individual body hydration'); },
    });
    expect((await list()).items.map(item => item.artifactId)).toEqual(['moved']);
    expect(hydrated).toEqual(['moved']);
    expect(resolveSessionMachineId).toHaveBeenCalledTimes(1);
    hydrated.length = 0;
    currentMachineId = 'machine-outside-grant';
    expect((await list()).items).toEqual([]);
    currentMachineId = null;
    expect((await list()).items).toEqual([]);
    expect(hydrated).toEqual([]);
    expect(resolveSessionMachineId).toHaveBeenCalledTimes(3);
  });

  it('opens only matching approval bodies across a large mixed inventory', async () => {
    const open = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      actionId: 'session.message.send', actionArgs: { sessionId: 'session-1', message: 'Other Action' },
      executionOriginV1: { ...builtIn.executionOriginV1, actionId: 'session.message.send' },
    });
    const otherMachine = ApprovalRequestV2Schema.parse({ ...builtIn,
      createdBy: { surface: 'agent', sessionId: 'session-2' },
      executionOriginV1: { ...builtIn.executionOriginV1, machineId: 'machine-2', sessionId: 'session-2' },
      actionArgs: { sessionId: 'session-2', title: 'Other Machine' },
    });
    const rows = [
      ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: `unrelated-${index}`, updatedAt: 4,
        header: { kind: 'prompt_doc.v2', title: 'Unrelated' }, body: 'private unrelated content' })),
      ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: `other-action-${index}`, updatedAt: 3,
        header: buildApprovalRequestArtifactHeaderV1(open), body: JSON.stringify(open) })),
      ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: `other-machine-${index}`, updatedAt: 3,
        header: buildApprovalRequestArtifactHeaderV1(otherMachine), body: JSON.stringify(otherMachine) })),
      { artifactId: 'target', updatedAt: 2, header: buildTargetActionApprovalArtifactHeaderV1(target), body: JSON.stringify(target) },
      { artifactId: 'selected', updatedAt: 1, header: buildApprovalRequestArtifactHeaderV1(builtIn), body: JSON.stringify(builtIn) },
    ];
    let bodyReads = 0;
    const result = await listApprovalArtifactsV1({ actionId: builtIn.actionId, status: 'executing', limit: 1,
      targetGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: ['machine-1'] } },
      resolveSessionMachineId: async sessionId => sessionId === 'session-1' ? 'machine-1' : 'machine-2',
      readPage: options => listArtifactHeadersV1({ options, encodeCursor: item => item.artifactId,
        readPage: async physical => {
          const selected = rows.filter(row => !physical?.kinds || physical.kinds.includes(String(row.header.kind)));
          const start = physical?.cursor ? selected.findIndex(row => row.artifactId === physical.cursor) + 1 : 0;
          const items = selected.slice(start, start + (physical?.limit ?? 500));
          if (physical?.includeBody) bodyReads += items.length;
          return { items: items.map(({ body, ...row }) => ({ ...row, createdAt: 1,
            ...(physical?.includeBody ? { body } : {}) })),
            kindCoverage: { status: 'complete' as const, unclassifiedCount: 0 as const },
            ...(start + items.length < selected.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
        },
        readBodies: async items => {
          bodyReads += items.length;
          return items.map(item => ({ ...item, body: rows.find(row => row.artifactId === item.artifactId)!.body }));
        },
      }),
      read: async artifactId => { bodyReads++; return rows.find(row => row.artifactId === artifactId) ?? null; },
    });
    expect(result.items.map(item => item.artifactId)).toEqual(['selected']);
    expect(bodyReads).toBe(1);
  });

  it('reads only open approval headers and bodies with ten thousand settled receipts', async () => {
    const settled = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'executed',
      execution: { executedAtMs: 3, ok: true, result: { success: true } } });
    const open = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined });
    const rows = [
      ...Array.from({ length: 10_000 }, (_, index) => ({ artifactId: `settled-${index}`, updatedAt: 3,
        header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled) })),
      ...Array.from({ length: 2 }, (_, index) => ({ artifactId: `open-${index}`, updatedAt: 2,
        header: buildApprovalRequestArtifactHeaderV1(open), body: JSON.stringify(open) })),
    ].sort((left, right) => right.updatedAt - left.updatedAt || right.artifactId.localeCompare(left.artifactId));
    let headerReads = 0;
    let bodyReads = 0;
    const result = await listApprovalArtifactsV1({ status: 'open',
      readPage: options => listArtifactHeadersV1({ options, encodeCursor: item => item.artifactId,
        // Observe the persistent transport boundary. Selection and strict
        // approval admission below it use the real internal implementations.
        readPage: async physical => {
          const states: unknown = Reflect.get(physical ?? {}, 'approvalStates');
          const selectedStates = Array.isArray(states) ? new Set(states.filter((state): state is string => typeof state === 'string')) : null;
          const selected = rows.filter(row => (!physical?.kinds || physical.kinds.includes(String(row.header.kind)))
            && (!selectedStates || selectedStates.has(String(row.header.approvalStatus))));
          const start = physical?.cursor ? selected.findIndex(row => row.artifactId === physical.cursor) + 1 : 0;
          const items = selected.slice(start, start + (physical?.limit ?? 500));
          headerReads += items.length;
          if (physical?.includeBody) bodyReads += items.length;
          return { items: items.map(({ body, ...row }) => ({ ...row, createdAt: 1,
            ...(physical?.includeBody ? { body } : {}) })),
            kindCoverage: { status: 'complete' as const, unclassifiedCount: 0 as const },
            ...(start + items.length < selected.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
        },
        readBodies: async items => {
          bodyReads += items.length;
          return items.map(item => ({ ...item, body: rows.find(row => row.artifactId === item.artifactId)!.body }));
        },
      }), read: async () => null,
    });
    expect(result.items.map(item => item.artifactId)).toEqual(['open-1', 'open-0']);
    expect(headerReads).toBe(2);
    expect(bodyReads).toBe(2);
  });

  it('projects managed Delete identity into the exact server index while retaining body authority', async () => {
    const request = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      actionId: 'machines.managed.delete', actionArgs: { homeId: 'home', managedId: 'managed', intent: 'delete',
        when: 'now', expectedRevision: 4, reviewedDependencies: true },
      executionOriginV1: { ...builtIn.executionOriginV1, actionId: 'machines.managed.delete' },
    });
    const header = buildApprovalRequestArtifactHeaderV1(request);
    const subjectKey = deriveManagedDeleteApprovalSubjectKeyV1({ homeId: 'home', managedId: 'managed' });
    expect(header).toMatchObject({ kind: 'approval_request.v1', approvalSubjectKey: subjectKey });
    expect(deriveArtifactStoredKindV1(header)).toBe(`v1:other:${managedDeleteApprovalIndexedKindV1(subjectKey)}`);
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(request)))
      .toEqual({ family: 'built_in', request });
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, approvalSubjectKey: `${subjectKey}-other` }, JSON.stringify(request)))
      .toBeNull();
    const readPage = vi.fn(async () => ({ items: [{ artifactId: 'managed-delete', header,
      body: JSON.stringify(request), updatedAt: 2 }] }));
    await expect(listApprovalArtifactsV1({ status: 'open', actionId: 'machines.managed.delete', subjectKey,
      readPage, read: async () => null })).resolves.toMatchObject({
      items: [{ artifactId: 'managed-delete', status: 'open', actionId: 'machines.managed.delete' }],
      queryPlan: { kind: 'bounded_approval_artifact_header_scan', boundedBy: 'exact approval subject key' },
    });
    expect(readPage).toHaveBeenCalledWith(expect.objectContaining({
      indexedKinds: [managedDeleteApprovalIndexedKindV1(subjectKey)], includeBody: true,
    }));
  });

  it('lists only open publication requests for the exact Workflow Run through the admitted return binding', async () => {
    const publication = (runId: string) => ApprovalRequestV2Schema.parse({ ...builtIn,
      status: 'open', decision: undefined, actionId: 'discussion.reply', actionArgs: {},
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'profile-1',
        serverIdentityId: 'server-identity-1', accountId: 'account-1', machineId: 'machine-1', requestId: 'publication', actionId: 'discussion.reply',
        caller: { kind: 'workflowRun', runId, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
        discussionReplyReturn: { kind: 'workflow_invocation', serverId: 'server-identity-1',
          producer: projectWorkflowDiscussionProducerV1({ runId, invocationRecordId: 'invocation-1', invocationAttempt: '0',
            blockKind: 'action', lifecycle: 'completed', execution: { kind: 'action', actionId: 'plugin:external/check' } }),
          origin: { discussion: { serverId: 'server-identity-1', discussionId: 'discussion-1' }, messageId: 'message-1', throughSeq: 1 } } },
    });
    const own = publication('workflow-a');
    const other = publication('workflow-b');
    const settled = { ...own, status: 'rejected' as const, decision: { kind: 'reject' as const, decidedAtMs: 2 } };
    const requests = [other, own, settled];
    const rows = requests.map((request, index) => ({ artifactId: `approval-${index}`,
      updatedAt: 2, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }));
    const readPage = vi.fn(async () => ({ items: rows }));
    const input = getActionSpec('approval.request.list').inputSchema.parse({ workflowRunId: 'workflow-a' });
    const result = await listApprovalArtifactsV1({ ...input, readPage, read: async () => null });
    expect(result.items.map(item => item.artifactId)).toEqual(['approval-1']);
    expect(readPage).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ['approval_request.v1', 'target_action_approval.v1'], approvalStates: ['open'],
    }));
    const bodyReads: string[] = [];
    const selected = await listApprovalArtifactsV1({ ...input,
      readPage: options => listArtifactHeadersV1({ options, encodeCursor: row => row.artifactId,
        readPage: async physical => {
          const start = physical?.cursor ? rows.findIndex(row => row.artifactId === physical.cursor) + 1 : 0;
          const items = rows.slice(start, start + (physical?.limit ?? 500));
          return { items: items.map(({ body: _body, ...row }) => ({ ...row, createdAt: 1 })),
            kindCoverage: { status: 'complete' as const, unclassifiedCount: 0 as const },
            ...(start + items.length < rows.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
        },
        readBodies: async items => {
          bodyReads.push(...items.map(row => row.artifactId));
          return items.map(row => ({ ...row, body: rows.find(item => item.artifactId === row.artifactId)!.body }));
        },
      }), read: async () => null,
    });
    expect(selected.items.map(item => item.artifactId)).toEqual(['approval-1']);
    expect(bodyReads).toEqual(['approval-1']);
  });

  it('FIX249 lists open caller invitations for the exact Run and Home', async () => {
    const invitation = (runId: string, serverId = 'identity-1') => ApprovalRequestV2Schema.parse({
      ...builtIn, status: 'open', decision: undefined, actionId: 'discussion.invite', actionArgs: {},
      executionOriginV1: { ...builtIn.executionOriginV1, serverId, serverIdentityId: serverId,
        actionId: 'discussion.invite', caller: { kind: 'workflowRun', runId,
          authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } },
    });
    const own = invitation('workflow-a');
    const external = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify({ ...target,
      status: 'open', requestedSurface: 'agent', decision: undefined, replayPlacement: undefined,
      executionOriginV1: { ...own.executionOriginV1, actionId: 'action.invoke' } })));
    const requests = [invitation('workflow-b'), own, invitation('workflow-a', 'foreign-home'),
      { ...own, status: 'rejected' as const, decision: { kind: 'reject' as const, decidedAtMs: 2 } }];
    const rows = requests.map((request, index) => ({ artifactId: `invitation-${index}`, updatedAt: 2,
      header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }));
    rows.push({ artifactId: 'external-request', updatedAt: 2,
      header: buildTargetActionApprovalArtifactHeaderV1(external), body: JSON.stringify(external) });
    const read = vi.fn(async () => null);
    const result = await listApprovalArtifactsV1({ workflowRunId: 'workflow-a', serverId: 'identity-1',
      readPage: async () => ({ items: rows }), read });
    expect(result.items.map(item => item.artifactId)).toEqual(['invitation-1', 'external-request']);
    expect(read).not.toHaveBeenCalled();
  });

  const host = ExecutionRunHostActionApprovalRequestV1Schema.parse({
    v: 1,
    kind: 'execution_run_host_action',
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'session-1' },
    requestedSurface: 'agent',
    actionId: 'reviews.comments.create',
    sessionId: 'session-1',
    runId: 'run-1',
    callId: 'call-1',
    profileId: 'profile-1',
    pluginId: 'plugin-1',
    agentId: 'agent-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    serverId: 'server-1',
    proposalCount: 1,
    proposalPreview: [{
      pathLabel: 'src/a.ts',
      pathSha256: 'c'.repeat(64),
      bodySha256: 'd'.repeat(64),
      bodyPreview: 'Change',
    }],
    subjectFingerprint: 'e'.repeat(64),
    summary: 'Create review comment',
  });

  it.each([
    ['built-in kind', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'kind'],
    ['built-in status', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'approvalStatus'],
    ['built-in session list', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'sessions'],
    ['built-in server identity', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'serverIdentityId'],
    ['built-in profile', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'serverId'],
    ['built-in machine', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'machineId'],
    ['built-in target kind', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'approvalTargetKind'],
    ['built-in run', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'runId'],
    ['target action id', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'qualifiedActionId'],
    ['target subject', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'subjectFingerprint'],
    ['target machine', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'machineId'],
    ['target target kind', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'approvalTargetKind'],
    ['host profile', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'profileId'],
    ['host server', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'serverId'],
    ['host run', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'runId'],
  ] as const)('fails closed for a contradictory %s header', (_label, family, request, header, field) => {
    const body = JSON.stringify(request);
    expect(approvalArtifactBodyMatchesHeaderV1(header, body)).toEqual({ family, request });
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, [field]: 'contradiction' }, body)).toBeNull();
  });

  it('indexes the list facts (automation origin, Discussion) in the header and verifies them against the body', () => {
    const origin = builtIn.executionOriginV1;
    const automation = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      executionOriginV1: { ...origin, runId: 'automation-run-1',
        caller: { kind: 'automationRun', runId: 'automation-run-1', automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } } } });
    const discussion = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined, discussionDraftReview: true,
      executionOriginV1: { ...origin, actionId: 'discussion.post' }, actionId: 'discussion.post',
      actionArgs: { discussionId: 'discussion-1', localId: 'local-1', content: 'Hello' } });
    const plain = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined });
    const facts = (request: Parameters<typeof buildApprovalRequestArtifactHeaderV1>[0]) =>
      buildApprovalRequestArtifactHeaderV1(request).approvalListFacts;
    expect([facts(automation), facts(discussion), facts(plain)]).toEqual([
      { automationId: 'automation-1' },
      { discussionId: 'discussion-1', discussionDraftReview: true },
      {},
    ]);
    // Header readers trust these facts only because body admission rejects a contradiction.
    const header = buildApprovalRequestArtifactHeaderV1(discussion);
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(discussion))?.request).toEqual(discussion);
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, approvalListFacts: { discussionId: 'other' } }, JSON.stringify(discussion))).toBeNull();
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, approvalListFacts: {} }, JSON.stringify(discussion))).toBeNull();
    // A header written before the facts existed is unclassified, not contradictory.
    const { approvalListFacts: _facts, ...unclassified } = header;
    expect(approvalArtifactBodyMatchesHeaderV1(unclassified, JSON.stringify(discussion))?.request).toEqual(discussion);
  });

  it('settles an obsolete v1 Discussion body whose header carries newer list facts', () => {
    const legacy = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId: 'discussion.post', actionArgs: { discussionId: 'discussion-1', content: 'Hello' }, summary: 'Post' });
    const currentHeader = buildApprovalRequestArtifactHeaderV1(legacy);
    expect(currentHeader.approvalListFacts).toEqual({});
    expect(readApprovalArtifactAdmissionV1(currentHeader, JSON.stringify(legacy))).toMatchObject({ kind: 'presented' });
    const header = { ...buildApprovalRequestArtifactHeaderV1(legacy), approvalListFacts: { discussionId: 'discussion-1' } };
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(legacy))).toBeNull();
    expect(readApprovalArtifactAdmissionV1(header, JSON.stringify(legacy))).toMatchObject({ kind: 'not_presented', reason: 'superseded_header_facts' });
    expect(readApprovalArtifactAdmissionV1(header, '{"v":9}')).toEqual({ kind: 'unreadable' });
    expect(readApprovalArtifactAdmissionV1(header, null)).toEqual({ kind: 'unreadable' });
  });

  it('rejects an unhydrated or wrong-family body instead of trusting the index header', () => {
    const header = buildApprovalRequestArtifactHeaderV1(builtIn);
    expect(approvalArtifactBodyMatchesHeaderV1(header, null)).toBeNull();
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(target))).toBeNull();
  });

  it.each([
    ['built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), ApprovalRequestV2Schema],
    ['target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), TargetActionApprovalRequestV1Schema],
    ['execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), ExecutionRunHostActionApprovalRequestV1Schema],
  ] as const)('reads known stored %s fields while strict admission rejects unknown fields', (family, request, header, schema) => {
    const stored = { ...request, future: true, createdBy: { ...request.createdBy, future: true } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, future: true }, JSON.stringify(stored)))
      .toEqual({ family, request });
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify({ ...stored, status: 'unknown' }))).toBeNull();
  });
});
