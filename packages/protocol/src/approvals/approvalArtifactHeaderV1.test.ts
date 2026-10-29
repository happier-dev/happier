import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema } from './approvalRequestV1.js';
import {
  approvalArtifactBodyMatchesHeaderV1,
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
    const filtered = await listApprovalArtifactsV1({ ...store, limit: 1, actionId: 'action.invoke' });
    expect(filtered.items.map(item => item.artifactId)).toEqual(['plugin-target']);
  });

  it('opens only matching approval bodies across a large mixed inventory', async () => {
    const open = ApprovalRequestV2Schema.parse({ ...builtIn, status: 'open', decision: undefined,
      actionId: 'session.message.send', actionArgs: { sessionId: 'session-1', message: 'Other Action' },
      executionOriginV1: { ...builtIn.executionOriginV1, actionId: 'session.message.send' },
    });
    const rows = [
      ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: `unrelated-${index}`, updatedAt: 4,
        header: { kind: 'prompt_doc.v2', title: 'Unrelated' }, body: 'private unrelated content' })),
      ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: `other-action-${index}`, updatedAt: 3,
        header: buildApprovalRequestArtifactHeaderV1(open), body: JSON.stringify(open) })),
      { artifactId: 'target', updatedAt: 2, header: buildTargetActionApprovalArtifactHeaderV1(target), body: JSON.stringify(target) },
      { artifactId: 'selected', updatedAt: 1, header: buildApprovalRequestArtifactHeaderV1(builtIn), body: JSON.stringify(builtIn) },
    ];
    let bodyReads = 0;
    const result = await listApprovalArtifactsV1({ actionId: builtIn.actionId, status: 'executing', limit: 1,
      readPage: options => listArtifactHeadersV1({ options, encodeCursor: item => item.artifactId,
        readPage: async physical => {
          const start = physical?.cursor ? rows.findIndex(row => row.artifactId === physical.cursor) + 1 : 0;
          const items = rows.slice(start, start + (physical?.limit ?? 500));
          if (physical?.includeBody) bodyReads += items.length;
          return { items: items.map(({ body, ...row }) => ({ ...row, createdAt: 1,
            ...(physical?.includeBody ? { body } : {}) })),
            ...(start + items.length < rows.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
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
    ['built-in run', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'runId'],
    ['target action id', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'qualifiedActionId'],
    ['target subject', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'subjectFingerprint'],
    ['target machine', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'machineId'],
    ['host profile', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'profileId'],
    ['host server', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'serverId'],
    ['host run', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'runId'],
  ] as const)('fails closed for a contradictory %s header', (_label, family, request, header, field) => {
    const body = JSON.stringify(request);
    expect(approvalArtifactBodyMatchesHeaderV1(header, body)).toEqual({ family, request });
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, [field]: 'contradiction' }, body)).toBeNull();
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
