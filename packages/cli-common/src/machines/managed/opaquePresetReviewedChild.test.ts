import { describe, expect, it } from 'vitest';
import { createHostReviewedChildPortV1, isHostAdmittedReviewedChildPolicyV1, readHostAdmittedReviewedParentV1, readHostReviewedChildOperationV1,
  type ActionExecutorContext, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createManagedOpaquePresetReviewedChildPortV1 } from './opaquePresetReviewedChild.js';

const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Fixture compute', icon: 'cloud',
  resourceKind: 'compute', schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
  resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
  billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'delete'] },
  actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', power: 'power' },
});

describe('opaque preset reviewed child issuer', () => {
  it('issues exactly the authenticated opened declaration role under the original parent', async () => {
    let observed: Readonly<{ input: unknown; context: ActionExecutorContext }> | undefined;
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.acquire', input: { homeId: 'home', managedId: 'managed' } },
      context: { surface: 'cli', actionsSettings: normalizeActionsSettingsV1({ v: 1 }) }, launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
        name: 'Private launch name', choices: {} }, provisioner, localId: 'acquire', role: 'acquire',
      execute: async (input, context): Promise<ActionExecuteResult> => {
        observed = { input, context };
        return { ok: true, result: { accepted: true } };
      },
    });

    expect(port).not.toBeNull();
    const result = await port!.invoke({ action: { pluginId: 'fixture.compute', localId: 'acquire' }, role: 'acquire',
      input: { privateChoice: 'opened-only' } });
    expect(result).toEqual({ ok: true, result: { accepted: true } });
    expect(observed?.input).toEqual({ privateChoice: 'opened-only' });
    expect(readHostAdmittedReviewedParentV1(observed?.context.hostReviewedChild)).toEqual({
      actionId: 'machines.managed.acquire', input: { homeId: 'home', managedId: 'managed' },
    });
  });

  it.each([
    ['dispatches the opened child when no explicit Require applies', {}, true],
    ['refuses an explicitly Required opened child before any native effect', { actions: {
      [formatQualifiedPluginActionId({ pluginId: 'fixture.compute', localId: 'acquire' })]: { approvalRequiredSurfaces: ['cli'] },
    } }, false],
  ] as const)('%s', async (_caseName, settings, admitted) => {
    let childContext: ActionExecutorContext | undefined;
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.acquire', input: { homeId: 'home', managedId: 'managed' } },
      context: { surface: 'cli', actionsSettings: normalizeActionsSettingsV1({ v: 1, ...settings }) },
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'acquire', role: 'acquire', execute: async (_input, context): Promise<ActionExecuteResult> => {
        childContext = context;
        return { ok: true, result: {} };
      },
    });

    const result = await port!.invoke({ action: { pluginId: 'fixture.compute', localId: 'acquire' }, role: 'acquire', input: { choice: 'x' } });
    if (!admitted) {
      expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(childContext).toBeUndefined();
      return;
    }
    const childId = formatQualifiedPluginActionId({ pluginId: 'fixture.compute', localId: 'acquire' });
    expect(isHostAdmittedReviewedChildPolicyV1(readHostReviewedChildOperationV1(childContext, childId, { choice: 'x' }),
      childId, { choice: 'x' })).toBe(true);
  });

  it.each([
    // An unlisted child of an approved parent inherits too (owner ruling 2026-11-15; covered below).
    ['consumes the approved parent policy for a listed child once', 'power', true],
  ] as const)('%s', async (_caseName, listedRole, admitted) => {
    const childAction = { pluginId: 'fixture.compute', localId: 'power' };
    const childId = formatQualifiedPluginActionId(childAction);
    // The person approved this parent with the child's explicit Require; a
    // selected approval profile leaves no default the child could re-decide.
    const context: ActionExecutorContext = { surface: 'cli', approvalProfileId: 'careful',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [childId]: { approvalRequiredSurfaces: ['cli'] } } }) };
    const parentInput = { homeId: 'home', managedId: 'managed', power: 'stop' };
    const parentPort = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: parentInput, context,
      reviewAdmitted: true, plan: { children: [{ action: { ...childAction, localId: listedRole }, role: listedRole }] },
      policies: [{ action: { ...childAction, localId: listedRole }, role: listedRole, surface: 'cli', requiredActionIds: [childId] }],
      execute: async () => ({ ok: true, result: {} }) });
    const runs: ActionExecutorContext[] = [];
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.power.set', input: parentInput },
      context: { ...context, hostReviewedChild: parentPort },
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'power', role: 'power', execute: async (_input, childContext): Promise<ActionExecuteResult> => {
        runs.push(childContext);
        return { ok: true, result: { stopped: true } };
      },
    });

    const result = await port!.invoke({ action: childAction, role: 'power', input: { power: 'stop' } });
    if (!admitted) {
      expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(runs).toHaveLength(0);
      return;
    }
    expect(result).toEqual({ ok: true, result: { stopped: true } });
    expect(runs).toHaveLength(1);
    expect(isHostAdmittedReviewedChildPolicyV1(readHostReviewedChildOperationV1(runs[0], childId, { power: 'stop' }),
      childId, { power: 'stop' })).toBe(true);
  });

  it.each([
    ['admits an unlisted child of a person-approved parent despite its own Require', 'approved', true],
    ['refuses the same child under an unapproved parent port', 'unapproved', false],
    ['refuses the same child under a forged parent claim', 'forged', false],
    ['refuses the same child when the approved port belongs to another parent', 'other-parent', false],
  ] as const)('%s', async (_caseName, parentKind, admitted) => {
    const childAction = { pluginId: 'fixture.compute', localId: 'acquire' };
    const childId = formatQualifiedPluginActionId(childAction);
    // Guest Update dea7de30: the person approved the parent in the app; the
    // opened acquire child carries the Account's own Require on surface ui.
    const context: ActionExecutorContext = { surface: 'ui',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [childId]: { approvalRequiredSurfaces: ['ui'] } } }) };
    const parentInput = { homeId: 'home', managedId: 'managed', expectedIntentRevision: 0 };
    const parentActionId = parentKind === 'other-parent' ? 'machines.managed.power.set' : 'machines.managed.bootstrap.retry';
    const hostReviewedChild = parentKind === 'forged'
      ? { parent: { actionId: 'machines.managed.bootstrap.retry', input: parentInput },
        invoke: async (): Promise<ActionExecuteResult> => ({ ok: true, result: {} }) }
      : createHostReviewedChildPortV1({ actionId: parentActionId, input: parentInput, context,
        ...(parentKind === 'unapproved' ? {} : { reviewAdmitted: true as const }) });
    const runs: ActionExecutorContext[] = [];
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.bootstrap.retry', input: parentInput },
      context: { ...context, hostReviewedChild },
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'acquire', role: 'acquire', execute: async (_input, childContext): Promise<ActionExecuteResult> => {
        runs.push(childContext);
        return { ok: true, result: { acquired: true } };
      },
    });

    const result = await port!.invoke({ action: childAction, role: 'acquire', input: { choice: 'x' } });
    if (!admitted) {
      expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(runs).toHaveLength(0);
      return;
    }
    expect(result).toEqual({ ok: true, result: { acquired: true } });
    expect(runs).toHaveLength(1);
    expect(isHostAdmittedReviewedChildPolicyV1(readHostReviewedChildOperationV1(runs[0], childId, { choice: 'x' }),
      childId, { choice: 'x' })).toBe(true);
  });

  it('refuses an action absent from the authenticated opened declaration', () => {
    expect(createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.acquire', input: {} }, context: { surface: 'cli', actionsSettings: normalizeActionsSettingsV1({ v: 1 }) },
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'foreign', role: 'acquire', execute: async (): Promise<ActionExecuteResult> => ({ ok: true, result: {} }),
    })).toBeNull();
  });

  it.each(['team-member', 'owner'])('allows an exact signed acquire on the custodian controller for requester %s', async requesterAccountId => {
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
      serverIdentityId: 'home', accountId: requesterAccountId, custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 }, machineId: 'controller', installationId: 'controller-installation',
      actionId: 'machines.managed.acquire', requestId: 'team-request', requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    const context: ActionExecutorContext = { surface: 'cli', actionsSettings: normalizeActionsSettingsV1({ v: 1 }), runtimeAccountId: requesterAccountId,
      actionRequestId: 'team-request',
      externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    let executions = 0;
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.acquire', input: { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 4 } } },
      context, custody: { homeId: 'home', custodianAccountId: 'owner', requestId: 'team-request',
        controller: { machineId: 'controller', installationId: 'controller-installation' } },
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'acquire', role: 'acquire', execute: async (): Promise<ActionExecuteResult> => {
        executions++;
        return { ok: true, result: { accepted: true } };
      },
    });

    await expect(port?.invoke({ action: { pluginId: 'fixture.compute', localId: 'acquire' }, role: 'acquire', input: {} }))
      .resolves.toEqual({ ok: true, result: { accepted: true } });
    expect(executions).toBe(1);
  });

  it.each([
    ['a different controller', 'team-member', { homeId: 'home', custodianAccountId: 'owner', requestId: 'team-request',
      controller: { machineId: 'other-controller', installationId: 'controller-installation' } }],
    ['a different signed request', 'team-member', { homeId: 'home', custodianAccountId: 'owner', requestId: 'other-request',
      controller: { machineId: 'controller', installationId: 'controller-installation' } }],
    ['a different runtime principal', 'unrelated-account', { homeId: 'home', custodianAccountId: 'owner', requestId: 'team-request',
      controller: { machineId: 'controller', installationId: 'controller-installation' } }],
    ['a different custodian', 'team-member', { homeId: 'home', custodianAccountId: 'unrelated-account', requestId: 'team-request',
      controller: { machineId: 'controller', installationId: 'controller-installation' } }],
  ] as const)('refuses a Team custodian child when custody names %s', async (_caseName, runtimeAccountId, custody) => {
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
      serverIdentityId: 'home', accountId: 'team-member', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 }, machineId: 'controller', installationId: 'controller-installation',
      actionId: 'machines.managed.acquire', requestId: 'team-request', requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    let executions = 0;
    const port = createManagedOpaquePresetReviewedChildPortV1({
      parent: { actionId: 'machines.managed.acquire', input: { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 4 } } },
      context: { surface: 'cli', actionsSettings: normalizeActionsSettingsV1({ v: 1 }), runtimeAccountId, actionRequestId: 'team-request',
        externalActionExecutionAuthorization: authorization, externalActionTarget: target },
      custody, launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Private', choices: {} },
      provisioner, localId: 'acquire', role: 'acquire', execute: async (): Promise<ActionExecuteResult> => {
        executions++;
        return { ok: true, result: { accepted: true } };
      },
    });

    await expect(port?.invoke({ action: { pluginId: 'fixture.compute', localId: 'acquire' }, role: 'acquire', input: {} }))
      .resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
    expect(executions).toBe(0);
  });
});
