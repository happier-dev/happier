import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { ActionSpecSchema, getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from './projectActionFamily.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { createActionExecutor } from './actionExecutor.js';
import { freezeActionCompletionContractV1 } from './actionCompletion.js';
import { readCompleteActionSpecV1 } from './actionSpecSections.js';

describe('Project preparation Action contracts', () => {
  it.each([true, false])('returns the Project Script spec and complete completion contract through action.spec.get (output schema: %s)', async includeOutputSchema => {
    const executor = createActionExecutor({});
    const discovered = await readCompleteActionSpecV1({
      actionId: 'projects.script.run',
      read: async input => {
        const result = await executor.execute('action.spec.get', { ...input, includeOutputSchema }, { surface: 'mcp' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.errorCode);
        return PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result.result);
      },
    });
    expect(discovered.id).toBe('projects.script.run');
    expect(discovered.completion).toEqual(freezeActionCompletionContractV1(getActionSpec('projects.script.run').completion!));
    expect(discovered.completion?.awaits).toBe('action_operations');
    expect(discovered.outputSchema !== undefined).toBe(includeOutputSchema);
  });

  it('asks by default for remembered setup consent on agent, MCP and CLI, and honors a surface waiver', () => {
    const spec = getActionSpec('projects.prepare');
    const input = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' },
      phase: 'setup', heldOperationId: 'held', expectedEffectDigest: 'reviewed', consentScope: 'untilChanged' };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, heldOperationId: undefined }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, skipForInvocation: true }).success).toBe(false);
    expect(resolveActionExecutionPlacementForInput(spec, input, undefined, 'ui')).toBe('account');
    expect(resolveActionExecutionPlacementForInput(spec, { ...input, consentScope: 'thisTime' }, undefined, 'ui')).toBe('machine');
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(spec.surfaces[surface]).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input, context: { surface, authority: 'account_automation' },
        settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      })).toMatchObject({ required: true, flow: 'deferred' });
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input, context: { surface, authority: 'account_automation' },
        settings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.prepare': [surface] } }),
      }).required).toBe(false);
    }
  });
  it('publishes Project page discovery as a closed client read with qualified plugin destinations', () => {
    const spec = getActionSpec(ActionIdSchema.parse('projects.pages.list'));
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client',
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true } });
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent' } }).required).toBe(false);
    const input = { workspaceRefId: 'checkout', serverId: 'home' };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ workspaceRefId: 'checkout' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, machineId: 'machine' }).success).toBe(false);
    const builtin = { id: 'overview', kind: 'builtin', title: 'Overview', icon: 'info',
      href: '/projects/checkout?serverId=home', disabledReason: null };
    const plugin = { ...builtin, id: 'acme.builds:builds', kind: 'plugin', title: 'Builds', icon: 'action',
      href: '/projects/checkout/plugins/acme.builds/builds?serverId=home', destination: { pluginId: 'acme.builds', localId: 'builds' } };
    expect(spec.outputSchema.parse({ pages: [builtin, plugin] })).toEqual({ pages: [builtin, plugin] });
    for (const page of [{ ...plugin, destination: undefined }, { ...builtin, destination: plugin.destination },
      { ...plugin, placement: 'hidden' }, { ...plugin, destination: { ...plugin.destination, authority: true } }]) {
      expect(spec.outputSchema.safeParse({ pages: [page] }).success).toBe(false);
    }
  });
  it.each([
    { kind: 'named', name: 'fresh' },
    { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'fresh' } },
  ])('shows the exact checkout, script and placement before approval: $kind', (selection) => {
    const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' };
    const choice = { kind: 'primary' };
    const actionArgs = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({ workspace, selection, choice });
    const presentation = describeApprovalActionFields({ actionId: 'projects.script.run', actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    for (const [path, value] of Object.entries({ workspace, selection })) {
      expect(presentation.rows).toContainEqual(expect.objectContaining({ kind: 'value', path, value: JSON.stringify(value) }));
    }
    expect(presentation.rows).toContainEqual(expect.objectContaining({ kind: 'value', path: 'choice', value: 'Primary' }));
  });
  it('withholds approval when a required checkout cannot be represented', () => {
    const presentation = describeApprovalActionFields({ actionId: 'projects.script.run', actionArgs: { selection: { kind: 'named', name: 'fresh' } } });
    expect(presentation.unrepresentable).toEqual({ path: 'workspace', reason: 'missing_required_context' });
  });
  it.each([
    ['projects.prepare', { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' }, phase: 'teardown', skipForInvocation: false, expectedEffectDigest: 'reviewed' }],
    ['projects.compute.exec', { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' }, executable: 'printf', argv: ['a b', 'c'], cwd: '/repo/subdir', choice: { kind: 'primary' } }],
    ['projects.trust.revoke', { project: { serverId: 'home', projectId: 'project' }, expectedRevision: 1, expectedEffectDigest: 'reviewed' }],
  ] as const)('represents each reviewed operand of %s', (actionId, input) => {
    const actionArgs = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
    const presentation = describeApprovalActionFields({ actionId, actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows.map(row => row.path)).toEqual(expect.arrayContaining(Object.keys(actionArgs)));
  });
  it('accepts actual finite completion declarations at the canonical catalog validator', () => {
    for (const id of ['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const) {
      expect(ActionSpecSchema.safeParse(getActionSpec(id)).success).toBe(true);
    }
  });
  it('requires the reviewed Trust row basis before revocation', () => {
    const project = { serverId: 'home', projectId: 'project' };
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.trust.revoke'].safeParse({ project }).success).toBe(false);
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.trust.revoke'].safeParse({ project, expectedRevision: 1, expectedEffectDigest: 'reviewed' }).success).toBe(true);
  });
  it('uses an exact admitted Workspace address, not caller-owned persisted row fields', () => {
    const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' };
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse({ workspace, phase: 'setup' }).success).toBe(true);
    expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse({ workspace: { ...workspace, projectKey: 'forged' }, phase: 'setup' }).success).toBe(false);
  });
  it('registers trust reads and configurable dangerous preparation without a trust-grant Action', () => {
    const ids = ['projects.trust.list', 'projects.trust.revoke', 'projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const;
    for (const id of ids) expect(ActionIdSchema.safeParse(id).success).toBe(true);
    expect(ActionIdSchema.safeParse('projects.trust.grant').success).toBe(false);
    for (const id of ids) {
      const spec = getActionSpec(id as Parameters<typeof getActionSpec>[0]);
      expect(spec.inputSchema.safeParse({ unexpected: true }).success).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
        context: { surface: 'agent' } }).required).toBe(id !== 'projects.trust.list');
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
        context: { surface: 'agent' }, settings: ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { [id]: ['agent'] },
        }) }).required).toBe(false);
    }
  });
});
