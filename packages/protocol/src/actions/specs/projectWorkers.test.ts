import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createWorkspaceExecutionConfigClientV1 } from '../../workspaces/workspaceExecutionConfigClientV1.js';
import { WorkspaceWorkerPreferenceGetInputV1Schema } from './projectWorkers.js';
import { ProjectServicePlacementActionInputSchemasV1 } from './projectServicePlacement.js';
import { computeWorkspaceSyncPolicyDigest } from '../../sessions/control/handoff/workspaceSyncSchemas.js';

describe('Project worker Actions', () => {
  it.each([
    ['projects.worker.preferences.get', false],
    ['projects.worker.preferences.set', true],
    ['projects.worker.preferences.reset', true],
    ['machines.worker.policy.get', false],
    ['machines.worker.policy.set', true],
    ['projects.worker.status', false],
    ['projects.worker.copy.inspect', false],
    ['projects.worker.copy.retire', true],
    ['projects.service.placement.get', false],
    ['projects.service.placement.set', true],
  ] as const)('exposes %s with configurable policy-write confirmation', (id, mutates) => {
    const actionId = ActionIdSchema.parse(id);
    const spec = getActionSpec(actionId);
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice', 'plugin'] as const) {
      expect(spec.surfaces[surface]).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, context: { surface } }).required).toBe(mutates);
      if (surface === 'ui') {
        expect(resolveActionApprovalRouting({ actionId, spec, context: { surface, authority: 'present_user' } }).required)
          .toBe(mutates);
      }
      expect(resolveActionApprovalRouting({ actionId, spec, context: { surface },
        settings: { v: 1, actions: {}, approvalWaivedSurfaces: { [id]: [surface] } } }).required).toBe(false);
    }
    expect(spec.cli?.commands).toContainEqual(expect.objectContaining({ path: id.split('.') }));
    expect(spec.outputSchema).toBeDefined();
    expect(spec.approval).toMatchObject(mutates ? { flow: 'deferred', result: 'optional' } : { result: 'required' });
  });

  it('exposes exact committed-copy review without caller paths or removal authority', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.worker.copy.inspect'));
    const retire = getActionSpec('projects.worker.copy.retire');
    const basis = JSON.parse(retire.examples!.voice!.argsExample!);
    const input = { ...basis, kind: 'preview', targetMachineId: 'worker', targetWorkspaceRefId: 'copy' };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, rootPath: '/caller/root' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, removeTargetCopy: { workspaceRefId: 'copy', rootFingerprint: 'a'.repeat(64) } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, expectedRelationship: undefined }).success).toBe(false);
    const preview = { targetMachineId: 'worker', workspaceRefId: 'copy', rootFingerprint: 'a'.repeat(64), sizeBytes: 0 };
    expect(spec.outputSchema?.safeParse({ ok: true, preview }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ok: true, preview: { ...preview, rootPath: '/unowned' } }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ok: false, errorCode: 'workspace_copy_not_owned' }).success).toBe(true);
  });

  it('publishes exact advisory status without admitting pool recursion or untyped observations', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.worker.status'));
    const input = { workspace: { serverId: 'home', refId: 'checkout' },
      destination: { kind: 'machine', machineId: 'worker-a' }, purpose: 'finite' };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const memoryDemand = { bytes: 1024, basis: { kind: 'declared' } };
    expect(spec.inputSchema.safeParse({ ...input, memoryDemand }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, memoryDemand: { ...memoryDemand, bytes: -1 } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, memoryDemand: { ...memoryDemand, arbitrary: true } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, destination: { kind: 'pool', poolId: '00000000-0000-4000-8000-000000000001', selection: 'automatic' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, purpose: 'background' }).success).toBe(false);
    const candidate = { serverId: 'home', machineId: 'worker-a' };
    const known = { kind: 'known', running: 1, queued: 2, accepting: true, runAtMost: 1 };
    expect(spec.outputSchema?.safeParse({ eligible: true, load: known, candidate, explanation: 'eligible' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ eligible: true, load: { kind: 'unknown' }, candidate, explanation: 'load_unknown' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ eligible: false, load: known, candidate: null, explanation: 'draining' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ eligible: false, load: known, candidate, explanation: 'draining' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ eligible: true, load: { ...known, running: -1 }, candidate, explanation: 'eligible' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ eligible: true, load: { arbitrary: true }, candidate, explanation: 'eligible' }).success).toBe(false);
  });

  it('retires only an exact reviewed relationship and separately named root-custodied removal', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.worker.copy.retire'));
    const content = { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] } as const;
    const expectedRelationship = { v: 1, relationshipId: 'copy-a', controllerMachineId: 'primary-a',
      alphaWorkspaceRefId: 'checkout', betaWorkspaceRefId: 'copy', mode: 'keep_synced', enabled: true,
      contentPolicy: { ...content, policyDigest: computeWorkspaceSyncPolicyDigest(content) }, createdAtMs: 1, updatedAtMs: 2 };
    const input = { workspace: { serverId: 'home', refId: 'checkout' }, machineId: 'worker-a', expectedRelationship };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const removeTargetCopy = { workspaceRefId: 'copy', rootFingerprint: 'a'.repeat(64) };
    expect(spec.inputSchema.safeParse({ ...input, removeTargetCopy }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, relationshipId: 'another-copy' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, removeTargetCopy: { ...removeTargetCopy, rootPath: '/raw/delete' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, removeTargetCopy: { ...removeTargetCopy, workspaceRefId: 'unrelated' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, expectedRelationship: undefined }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'retired' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'retired', dependencies: [] }).success).toBe(false);
  });

  it('admits exact finite preference writes and rejects service or whole-settings payloads', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.worker.preferences.set'));
    const next = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} };
    const input = { workspace: { serverId: 'home', refId: 'checkout' }, expectedRevision: 'absent',
      expected: { kind: 'absent' }, next };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, next: { ...next, services: {} } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, services: {} }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, workspace: { serverId: 'home', directory: '/checkout' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBe(false);
  });

  it('admits only a service semantic entry and keeps effect or finite state out of saved placement', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.service.placement.set'));
    const value = { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-a' } }, unavailable: 'fail' };
    const input = { workspace: { serverId: 'home', refId: 'checkout' }, serviceName: 'web', expectedRevision: 1,
      expected: { kind: 'absent' }, value };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(ProjectServicePlacementActionInputSchemasV1['projects.service.placement.set'].parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, value: { ...value, phase: 'running' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, enabled: true }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, expected: { kind: 'value', value: { ...value, url: 'http://localhost' } } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, value: { ...value, runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-a', poolId: 'other' } } } }).success).toBe(false);
  });

  it('publishes desired placement separately from strict actual native custody and refuses suggestions as bindings', () => {
    const schema = getActionSpec(ActionIdSchema.parse('projects.service.placement.get')).outputSchema!;
    const desired = { status: 'ready', placement: { runsOn: { kind: 'primary' }, unavailable: 'fail' }, revision: 'absent', provenance: 'default' };
    const target = { id: 'service', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
      machineId: 'worker', workspaceId: 'copy', workspace: { serverId: 'home', workspaceId: 'copy', machineId: 'worker', rootPath: '/copy' },
      declaration: { workspaceRefId: 'copy', selection: { kind: 'manifest', name: 'web' } }, cwd: '/copy', serviceState: 'running',
      title: 'web', confidence: 'high', state: 'available', actions: ['manage'] };
    expect(schema.safeParse({ ...desired, actual: { status: 'present', target } }).success).toBe(true);
    expect(schema.safeParse(desired).success).toBe(false);
    expect(schema.safeParse({ ...desired, actual: { status: 'present', target: { ...target, sourceClass: undefined } } }).success).toBe(false);
    expect(schema.safeParse({ ...desired, actual: { status: 'present', target: { ...target, declaration: undefined } } }).success).toBe(false);
    expect(schema.safeParse({ ...desired, actual: { status: 'ambiguous', targets: [target] } }).success).toBe(false);
    for (const status of ['absent', 'unavailable']) expect(schema.safeParse({ ...desired, actual: { status } }).success).toBe(true);
  });

  it('returns the row owner observation through the canonical executor and refuses an absent producer', async () => {
    const workspace = { serverId: 'home', refId: 'checkout' };
    const result = { status: 'ready', preference: { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} },
      revision: 'absent', provenance: 'default' } as const;
    let readResponse: unknown = { status: 'absent' };
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, isCurrent: () => true,
      randomBytes: () => { throw new Error('a keyless read must not generate encryption material'); },
      // The authenticated Home read is the external boundary; the row codec and semantic owner remain real.
      transport: { read: async () => readResponse, mutate: async () => { throw new Error('a read must not mutate'); } },
    });
    // Unused transport boundaries are absent; the callback composes the real row owner rather than replacing it.
    const executor = createActionExecutor({ projectWorkerAction: ({ actionId, input }) => {
      if (actionId !== 'projects.worker.preferences.get') throw new Error('unexpected settings mutation');
      return client.get(WorkspaceWorkerPreferenceGetInputV1Schema.parse(input));
    } } satisfies Partial<ActionExecutorDeps> as unknown as ActionExecutorDeps);
    await expect(executor.execute('projects.worker.preferences.get', { workspace }, { surface: 'cli' }))
      .resolves.toEqual({ ok: true, result });
    const unbacked = createActionExecutor({} as unknown as ActionExecutorDeps);
    await expect(unbacked.execute('projects.worker.preferences.get', { workspace }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    readResponse = { arbitrary: true };
    await expect(executor.execute('projects.worker.preferences.get', { workspace }, { surface: 'cli' }))
      .resolves.toEqual({ ok: true, result: { status: 'invalid' } });
  });
});
