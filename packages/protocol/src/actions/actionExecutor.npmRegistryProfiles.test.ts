import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { buildApprovalExecutionOriginV1, createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const target = { serverIdentityId: 'srv_registry', machineId: 'registry-machine' };
const ids = ['list', 'add', 'update', 'remove', 'login', 'logout', 'test'] as const;
const profile = { displayName: 'Work', origin: 'https://registry.example', scopes: ['@work'],
  useAsDefault: false, allowPrivateNetwork: false };

describe('npm registry profile Action admission', () => {
  it('makes every profile intent available through the real client relay and strict public schemas', async () => {
    for (const intent of ids) {
      const id = ActionIdSchema.parse(`plugins.npm_registry_profiles.${intent}`);
      const spec = getActionSpec(id);
      const input = intent === 'list' ? { target } : { target, profileId: 'work', expectedRevision: 7,
        mutationId: `registry-${intent}`, ...(['add', 'update'].includes(intent) ? { profile } : {}) };
      const output = { status: 'success', snapshot: { protocolVersion: 1, revision: 8, profiles: [], pausedSources: [] } };
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(spec.inputSchema.safeParse(input).success, intent).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, credential: { kind: 'bearer_token', secret: 'private-token' } }).success).toBe(false);
      const executor = createActionExecutor({ isActionApprovalRequired: () => false,
        clientActionExecute: async request => {
          expect(request).toMatchObject({ actionId: id, input });
          return { ok: true, result: output };
        } });
      for (const surface of ['cli', 'mcp'] as const) {
        expect(await executor.execute(id, input, { surface, authority: 'account_automation' }))
          .toEqual({ ok: true, result: output });
      }
      expect(spec.outputSchema?.safeParse(output).success).toBe(true);
    }
  });

  it('keeps Off and Ask-first in the executor before profile effects', async () => {
    const id = ActionIdSchema.parse('plugins.npm_registry_profiles.remove');
    const input = { target, profileId: 'work', expectedRevision: 7, mutationId: 'remove-work' };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { disabledSurfaces: ['ui'] } } });
    let effects = 0;
    const executor = createActionExecutor({
      npmRegistryProfileAction: async () => { effects++; return { status: 'outcomeUnknown' }; },
      isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings, context),
      isActionApprovalRequired: () => false,
    });
    expect(await executor.execute(id, input, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false });
    expect(effects).toBe(0);
    const asking = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { approvalRequiredSurfaces: ['ui'] } } });
    const askExecutor = createActionExecutor({
      npmRegistryProfileAction: async () => { effects++; return { status: 'outcomeUnknown' }; },
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, asking, context),
    });
    expect(await askExecutor.execute(id, input, { surface: 'ui', authority: 'present_user', actionsSettings: asking }))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(effects).toBe(0);
  });

  it('binds approval custody to the exact registry target before ambient Machine hints', () => {
    const id = ActionIdSchema.parse('plugins.npm_registry_profiles.login');
    const input = { target, profileId: 'work', expectedRevision: 7, mutationId: 'login-work' };
    const context = { serverId: 'home-registry', serverIdentityId: target.serverIdentityId,
      surface: 'ui' as const, authority: 'present_user' as const, actionRequestId: 'registry-login',
      executionRunTargetMachineId: 'ambient-machine', defaultSessionMachineId: 'session-machine' };
    expect(buildApprovalExecutionOriginV1({ actionId: id, input, context, targetSessionId: null }))
      .toMatchObject({ serverIdentityId: target.serverIdentityId, machineId: target.machineId });
    expect(buildApprovalExecutionOriginV1({ actionId: id, input,
      context: { ...context, serverIdentityId: 'srv_another' }, targetSessionId: null })).toBeNull();
  });
});
