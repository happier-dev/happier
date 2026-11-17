import { describe, expect, it } from 'vitest';
import { ActionSpecSchema } from './specs/definition.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from './actionExecutionResult.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { ArtifactActionInputSchemasV1, type ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { ProjectAccountOrganizationV1Schema } from '../projects/projectAccountRowsV1.js';
import { setProjectSetupV1, type ProjectSetupSetInputV1 } from '../projects/projectSetupSetV1.js';
import { ProjectDefinitionInspectOutputSchema } from './projectDefinitionActionFamily.js';
import type { z } from 'zod/mini';

describe('setup decision protected Artifact children', () => {
  it('retains the protected Artifact scope in the public reviewed-child declaration', () => {
    const childDeclaration = ActionSpecSchema.shape.hostReviewedChildren;
    expect(childDeclaration.parse([{ action: 'artifact.create', role: 'artifact.create' }]))
      .toEqual([{ action: 'artifact.create', role: 'artifact.create' }]);
    expect(childDeclaration.parse(getActionSpec('projects.setup.set').hostReviewedChildren))
      .toEqual([{ action: 'artifact.create', role: 'artifact.create',
        scopeInput: { header: { kind: 'project_setup.v1' } } }]);
  });
  it.each(['cli', 'ui'] as const)('creates and reopens accepted detail under one reviewed %s setup decision', async surface => {
    let organization = ProjectAccountOrganizationV1Schema.parse({});
    let revision = -1;
    let ownerRead = true;
    const documents = new Map<string, z.infer<typeof ArtifactDocumentV1Schema>>();
    const acceptedIds: string[] = [];
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    // Authenticated Artifact transport, Account row CAS, and Machine inspection are
    // process boundaries; executor admission, protected schemas and setup writer stay real.
    const artifactAction: NonNullable<ActionExecutorDeps['artifactAction']> = async ({ actionId, input }) => {
      if (actionId === 'artifact.create') {
        const created = ArtifactActionInputSchemasV1['artifact.create'].parse(input);
        if ('uploadPath' in created) throw new Error('Unexpected file upload');
        const accepted = created.header.kind === 'project_setup.v1';
        const artifactId = accepted ? ids[acceptedIds.length] : created.artifactId;
        if (!artifactId) throw new Error('Unexpected extra accepted detail');
        if (accepted) acceptedIds.push(artifactId);
        const currentRevision = { headerVersion: 1, bodyVersion: 1 };
        documents.set(artifactId, { artifactId, header: created.header, body: created.body,
          revision: currentRevision, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 });
        return { artifactId, revision: currentRevision };
      }
      if (actionId === 'artifact.get') {
        const read = ArtifactActionInputSchemasV1['artifact.get'].parse(input);
        const artifact = documents.get(read.artifactId);
        return { artifact: artifact ? { ...artifact, access: ownerRead ? 'owner' : 'view' } : null };
      }
      throw new Error('Unexpected Artifact operation');
    };
    const deferredApprovals: string[] = [];
    let stored: ApprovalRequestV2 | null = null;
    const executor = createActionExecutor({ artifactAction,
      approvalsCreate: async ({ request }) => {
        deferredApprovals.push(request.actionId);
        stored = ApprovalRequestV2Schema.parse(structuredClone(request));
        return { artifactId: 'setup-review' };
      },
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing setup approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      readActionsSettings: context => context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }),
      projectDefinitionAction: async () => ProjectDefinitionInspectOutputSchema.parse({
        definition: { basis: { kind: 'absent' }, document: null },
        detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
      }),
      projectsSetupSet: ({ input, context, executeCanonicalAction }) => setProjectSetupV1({
        execute: executeCanonicalAction,
        mutateOrganization: async mutation => {
          if (mutation.expectedRevision !== (revision < 0 ? 'absent' : revision)) return { status: 'conflict', revision };
          organization = await mutation.mutate(organization);
          revision += 1;
          return { status: 'updated', revision, value: organization };
        },
      }, input, context),
    });
    const context: ActionExecutorContext = { surface, authority: 'present_user', runtimeAccountId: 'owner',
      expectedAccountId: 'owner', serverId: 'home', serverIdentityId: 'home', actionRequestId: 'setup-request',
      actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId: 'projects.setup.set' },
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    const controlId = '33333333-3333-4333-8333-333333333333';
    expect(await executor.execute('artifact.create', { artifactId: controlId, header: { title: 'Control' }, body: 'ordinary' },
      { ...context, presentUserConfirmation: { actionId: 'artifact.create' } }))
      .toMatchObject({ ok: true, result: { artifactId: controlId } });
    expect(documents.get(controlId)?.body).toBe('ordinary');
    const root: ProjectSetupSetInputV1 = { projectRef: { serverId: 'home', projectKey: 'project' },
      workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'checkout', rootPath: '/repo' },
      expectedRevision: 'absent', intent: { kind: 'personal', setupOverrides: { version: 1,
        workspace: { setup: [{ kind: 'command', command: 'echo first' }] } } } };
    const executeSetup = async (input: ProjectSetupSetInputV1): Promise<ActionExecuteResult> => {
      const result = await executor.execute('projects.setup.set', input, context);
      const pending = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
      if (!pending?.success) return result;
      expect(pending.data.actionId).toBe('projects.setup.set');
      const decided = await executor.execute('approval.request.decide', {
        artifactId: pending.data.artifactId, decision: 'approve',
      }, { ...context, surface: 'ui', presentUserConfirmation: { actionId: 'approval.request.decide' } });
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { execution: { ok: true } } });
      const execution = ApprovalRequestV2Schema.parse(stored).execution;
      if (!execution || !execution.ok) throw new Error('Setup approval did not execute');
      return { ok: true, result: execution.result };
    };
    const first = await executeSetup(root);
    expect(first, JSON.stringify({ first, deferredApprovals })).toMatchObject({ ok: true,
      result: { ok: true, revision: 0, row: { setupContent: { artifactId: ids[0] } } } });
    expect(await executeSetup({ ...root, expectedRevision: 0,
      intent: { kind: 'personal', setupOverrides: { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo changed' }] } } } }))
      .toMatchObject({ ok: true, result: { ok: true, revision: 1, row: { setupContent: { artifactId: ids[1] } } } });
    expect(deferredApprovals).toEqual(surface === 'cli' ? ['projects.setup.set', 'projects.setup.set'] : []);
    expect(acceptedIds).toEqual(ids);
    expect(documents.size).toBe(3);
    const changedBody = documents.get(ids[1])?.body;
    if (typeof changedBody !== 'string') throw new Error('Accepted detail is unavailable');
    expect(JSON.parse(changedBody) as unknown).toMatchObject({ setupOverrides: { workspace: { setup: [{ command: 'echo changed' }] } } });
    const acceptedInput = { header: { kind: 'project_setup.v1' },
      body: JSON.stringify({ kind: 'project_setup.v1', setupOverrides: { version: 1 } }) };
    // A caller-supplied decoded root cannot manufacture host-child authority.
    expect(await executor.execute('artifact.create', acceptedInput, { ...context, presentUserConfirmation: { actionId: 'artifact.create' }, projectSetupSetRootInput: root }))
      .toMatchObject({ ok: false, errorCode: 'artifact_kind_internal' });
    expect(await executor.execute('artifact.get', { artifactId: ids[0] }, context))
      .toMatchObject({ ok: true, result: { artifact: { artifactId: ids[0], access: 'owner' } } });
    ownerRead = false;
    expect(await executor.execute('artifact.get', { artifactId: ids[0] }, context))
      .toMatchObject({ ok: false, errorCode: 'artifact_kind_internal' });
    expect(acceptedIds).toEqual(ids);
    expect(documents.size).toBe(3);
  });
});
