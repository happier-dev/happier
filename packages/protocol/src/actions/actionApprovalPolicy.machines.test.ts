import { describe, expect, it } from 'vitest';
import { ACTION_IDS } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';

const corridorActionIds = ACTION_IDS.filter(id => /^machines\.(managed\.|presets\.|pools\.|access\.|provisioners\.|replacement\.|add\.ssh\.|environment\.apply$)/.test(id)
  || id.startsWith('connectedServices.authentication.'));

describe('Corridor C approval defaults', () => {
  it('retains a verified controller UI invocation default across its external transport', () => {
    const actionId = 'machines.managed.acquire';
    const target = { kind: 'machine', machineId: 'controller' } as const;
    // Credential-backed host ingress has already produced this invocation
    // authority. Transport custody does not introduce a second approval floor.
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, runtimeAccountId: 'company',
      externalActionExecutionAuthorization: { v: 1, token: 'controller-root', binding: {
        serverIdentityId: 'home', accountId: 'member', custodianAccountId: 'company',
        authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        actionId, requestId: 'controller-click', target, machineId: target.machineId,
        installationId: 'controller-installation', requestEnvelopeDigest: '0'.repeat(64),
      } } };
    const args = { actionId, spec: getActionSpec(actionId), context } as const;
    expect(resolveActionApprovalRouting(args).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args, context: { ...context, authority: 'account_automation' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(true);
  });

  it('applies a host-proved sharing reduction directly only for a present UI user, preserving Ask and automation policy', () => {
    const actionId = 'machines.access.grant.set';
    const args = { actionId, spec: getActionSpec(actionId), defaultUiConfirmation: false,
      context: { surface: 'ui', authority: 'present_user' } } as const;
    const settings = normalizeActionsSettingsV1({ v: 1 });
    expect(resolveActionApprovalRouting({ ...args, settings }).required).toBe(false);
    expect(resolveActionApprovalRouting(args).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args, defaultUiConfirmation: undefined, settings }).required).toBe(true);
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ ...args, settings, context }).required).toBe(true);
      expect(resolveActionApprovalRouting({ ...args, context, settings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { [actionId]: [surface] } }) }).required).toBe(false);
    }
    expect(resolveActionApprovalRouting({ ...args, settings,
      context: { surface: 'ui', authority: 'account_automation' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(true);
  });

  it.each([
    'machines.terminal.open',
    'machines.processes.stop',
    'machines.daemon.stop', 'machines.replacement.set', 'machines.replacement.clear',
    'machines.managed.acquire', 'machines.managed.power.set', 'machines.managed.retention.update',
    'machines.managed.controller.update', 'machines.managed.setup.skip',
    'machines.presets.create', 'machines.presets.update', 'machines.presets.archive', 'machines.presets.restore',
    'machines.access.grant.remove', 'machines.access.leave',
  ] as const)('applies reversible %s directly only for the present user in the app', actionId => {
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    for (const settings of [undefined, normalizeActionsSettingsV1({ v: 1 })]) {
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec, settings,
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, settings,
        context: { surface: 'ui', authority: 'account_automation' } }).required).toBe(true);
    }
    expect(resolveActionApprovalRouting({ actionId, spec, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
    }).required).toBe(true);
  });

  it('keeps present-user terminal input under admitted custody while automation and explicit Ask still require approval', () => {
    const actionId = 'machines.terminal.write';
    const settings = normalizeActionsSettingsV1({ v: 1 });
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({ actionId, spec, settings,
      context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      expect(resolveActionApprovalRouting({ actionId, spec, settings,
        context: { surface, authority: 'account_automation' } }).required).toBe(true);
    }
    expect(resolveActionApprovalRouting({ actionId, spec,
      settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
      context: { surface: 'ui', authority: 'present_user' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: 'machines.terminal.open', spec: getActionSpec('machines.terminal.open'), settings,
      context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
  });
  it('honors a surface-specific waiver on every machine and provisioner Connect Action; an explicit Ask wins', () => {
    expect(corridorActionIds.length).toBeGreaterThan(0);
    for (const actionId of corridorActionIds) {
      const spec = getActionSpec(actionId);
      for (const surface of Object.keys(spec.surfaces) as (keyof typeof spec.surfaces)[]) {
        if (!spec.surfaces[surface]) continue;
        const context = { surface, authority: 'account_automation' } as const;
        const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(isApprovalRequiredByActionsSettings(actionId, waived, context), `${actionId}:${surface}`).toBe(false);
        expect(resolveActionApprovalRouting({ actionId, spec, settings: waived, context }).required, `${actionId}:${surface}`).toBe(false);
        const required = normalizeActionsSettingsV1({ ...waived, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, settings: required, context }).required, `${actionId}:${surface}`).toBe(true);
      }
      if (spec.safety === 'danger') {
        expect(resolveActionApprovalRouting({ actionId, spec, settings: normalizeActionsSettingsV1({ v: 1 }),
          context: { surface: 'agent', authority: 'account_automation' } }).required, actionId).toBe(true);
      }
    }
  });

  it('keeps Defaults, creation preferences and terminal host writes user-waivable through the shared Settings Action', () => {
    for (const anchor of ['machines.defaults.local', 'machines.defaults.runningOnly', 'machines.defaults.stoppedBilled',
      'machines.defaults.unknown', 'machines.defaults.creationEnabled', 'machines.terminal.host']) {
      for (const actionId of ['settings.set', 'settings.reset'] as const) {
        for (const surface of ['agent', 'mcp', 'ui', 'cli', 'voice', 'plugin', 'api'] as const) {
          const context = { surface, authority: 'account_automation' } as const;
          const args = { actionId, spec: getActionSpec(actionId), input: { anchor }, context };
          expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1 }) }).required, `${anchor}:${surface}`).toBe(true);
          const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
          expect(resolveActionApprovalRouting({ ...args, settings: waived }).required, `${anchor}:${surface}`).toBe(false);
        }
        const args = { actionId, spec: getActionSpec(actionId), input: { anchor },
          context: { surface: 'ui', authority: 'present_user' } as const };
        expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1 }) }).required,
          `${anchor}:present_user`).toBe(false);
        expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
          actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(true);
      }
    }
  });

  it('defaults pool Delete to Ask-first on UI and lets the user waive or restore it', () => {
    const actionId = 'machines.pools.delete' as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const args = { actionId, spec: getActionSpec(actionId), context };
    expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1 }) }))
      .toMatchObject({ required: true, flow: 'deferred' });
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(resolveActionApprovalRouting({ ...args, settings: waived }).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args, settings: waived, context: { surface: 'agent' } }).required).toBe(true);
    const required = normalizeActionsSettingsV1({ ...waived, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(resolveActionApprovalRouting({ ...args, settings: required }).required).toBe(true);
  });
});
