import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema, MachineSetupReportInputV1Schema, machineSetupApplyTargetFromPlanV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { accountSettingsParse, formatSavedSecretCatalogReferenceV1, sealSavedSecretResourceStoredContentV1, machineSetupItemKeyV1 } from '@happier-dev/protocol';
import { commitActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createNativeSoftwareInstallFixture, osStore } from '@/testkit/machines/nativeSoftwareInstall';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { readFile } from 'node:fs/promises';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { installPackage } from '../../../../../packages/plugins/machine-recipes/src/installPackage';

describe('admitted Machine setup snapshot lifetime', () => {
  beforeEach(() => {
    nativeTerminal.launches.length = 0;
    nativeTerminal.exit = undefined;
    nativeTerminal.onLaunch = undefined;
    nativeTerminal.autoExit = false;
  });
  it.each([
    { status: 401, body: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' }, code: 'invalid_token' },
    { status: 409, body: { code: 'preset_archived' }, code: 'preset_archived' },
    { status: 500, body: { code: 'private_server_code', message: 'PRIVATE_HOME_RESPONSE' }, code: 'machine_setup_request_failed' },
  ])('preserves closed Home refusal and HTTP status in preset Plan ($status)', async ({ status, body, code }) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    // HTTP is the boundary; the Plan Action, signing, and failure projection remain real.
    const home = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe('/v1/machines/setup/resolve');
      return { status, data: body };
    });
    onTestFinished(() => home.mockRestore());
    const result = await fixture.createExecutor(fixture.credentials).execute('machines.setup.plan', {
      homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects',
      sources: [{ kind: 'accountPresetOpaque', presetId: 'saved-preset', presetRevision: 1, contentEncryptionMode: 'plain' },
        { kind: 'direct', setup: {} }],
    }, fixture.context('machines.setup.plan'));
    expect(result).toMatchObject({ ok: false, errorCode: code,
      failureCause: { phase: 'machines.setup.plan', httpStatus: status } });
    if (status === 401) expect(result).toMatchObject({ details: {
      error: 'invalid_token', authorizationRefusal: 'verification_purpose',
    } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HOME_RESPONSE');
    expect(JSON.stringify(result)).not.toContain('private_server_code');
    expect(fixture.rootLaunches).toEqual([]);
    expect(fixture.metadataWrites).toEqual([]);
  });
  it('preserves network failure codes when preset Plan cannot reach Home', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    const home = vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }));
    onTestFinished(() => home.mockRestore());
    expect(await fixture.createExecutor(fixture.credentials).execute('machines.setup.plan', {
      homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects',
      sources: [{ kind: 'accountPresetOpaque', presetId: 'saved-preset', presetRevision: 1, contentEncryptionMode: 'plain' },
        { kind: 'direct', setup: {} }],
    }, fixture.context('machines.setup.plan'))).toMatchObject({ ok: false, errorCode: 'ECONNRESET',
      failureCause: { httpStatus: null } });
  });
  it.each([
    { exitCode: 0, reportFailure: 'lost', reportState: 'terminal' },
    { exitCode: 0, reportFailure: 'refused', reportState: 'terminal' },
    { exitCode: 23, reportFailure: 'lost', reportState: 'terminal' },
    { exitCode: 23, reportFailure: 'refused', reportState: 'terminal' },
    { exitCode: 0, reportFailure: 'lost', reportState: 'running' },
  ] as const)('preserves native outcome when the $reportState report is $reportFailure (native exit $exitCode)', async ({ exitCode, reportFailure, reportState }) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    const preset = { kind: 'accountPresetOpaque' as const, presetId: 'creation-preset', presetRevision: 1,
      contentEncryptionMode: 'plain' as const };
    const sources = [preset, { kind: 'direct' as const, setup: {} }];
    const resolvedSources = [{ ...preset, presetContent: { content: { t: 'plain', v: { v: 1, name: 'Creation',
      setup: { scripts: [{ body: `exit ${exitCode}`, affects: 'none' }] } } }, recipientEnvelope: null } }, sources[1]!];
    const reports: Array<Extract<ReturnType<typeof MachineSetupReportInputV1Schema.parse>, { state: unknown }>> = [];
    // Home transport is the boundary; planning, native tasks, and operation settlement remain real.
    const home = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname === '/v1/machines/setup/resolve') return { status: 200,
        data: { sources: resolvedSources, creation: { managedId: 'creation-machine', preset: { id: 'creation-preset', revision: 1 } } } };
      expect(new URL(String(url)).pathname).toBe('/v1/machines/setup/report');
      const report = MachineSetupReportInputV1Schema.parse(body);
      if (!('state' in report)) throw new Error('Expected Setup state report');
      reports.push(report);
      if (report.state === 'running' && reportState !== 'running') return { status: 200, data: {} };
      if (reportFailure === 'lost') throw Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
      return { status: 409, data: {} };
    });
    onTestFinished(() => home.mockRestore());
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan'),
    }));
    const context = fixture.context('machines.setup.apply');
    const authorization = context.externalActionExecutionAuthorization!;
    const creationContext = { ...context, externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization, binding: { ...authorization.binding, managedContinuation: {
        managedId: 'creation-machine', creationRequestId: 'creation', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: 'b'.repeat(43),
      } },
    }) };
    nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(exitCode));
    const result = await fixture.apply({ input: { ...target, desiredRevision: plan.desiredRevision,
      sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] }, context: creationContext });
    if (reportState === 'running') {
      expect(result).toMatchObject({ ok: false, errorCode: 'ECONNRESET' });
      expect(reports.map(report => report.state)).toEqual(['running']);
      expect(nativeTerminal.launches).toHaveLength(0);
      expect(fixture.metadataWrites).toHaveLength(0);
      return;
    }
    expect(result).toMatchObject(exitCode === 0 ? { operationId: expect.any(String) }
      : { ok: false, errorCode: 'machine_setup_setup_failed',
        details: { kind: 'finiteCommand', phase: 'setup', step: 0, exitCode } });
    expect(reports.map(report => ({ state: report.state, errorCode: report.errorCode }))).toEqual([
      { state: 'running', errorCode: undefined },
      { state: exitCode === 0 ? 'succeeded' : 'failed', errorCode: exitCode === 0 ? undefined : 'machine_setup_setup_failed' },
    ]);
    expect(nativeTerminal.launches).toHaveLength(1);
  });
  it.each(['plain', 'e2ee'] as const)('clears a direct pre-existing recipe through Apply → conflict → Remove → replacement (%s)', async accountEncryptionMode => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'first-present', accountEncryptionMode,
      additionalPlugins: [{ files: {}, manifest: { schemaVersion: 2, id: 'happier.machine.recipes', version: '1.0.0',
        displayName: 'Machine recipes', runtime: { apiVersion: 1 }, contributes: {
          machineRecipes: [{ id: 'install-package', ...installPackage }],
        } } }],
    });
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'happier.machine.recipes', recipeId: 'install-package', revision: '1' },
      inputs: { package: { manager: 'apt', apt: { name: 'jq' } } },
    } };
    const sources = [{ kind: 'direct' as const, setup: { items: [item] } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { ...target, desiredRevision: plan.desiredRevision,
      sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] },
      context: fixture.context('machines.setup.apply') })).toMatchObject({ operationId: expect.any(String) });
    const read = () => fixture.machineSetupPlan({ input: target, context: fixture.context('machines.setup.plan') });
    const persisted = MachineSetupPlanResultV1Schema.parse(await read());
    expect(persisted).toMatchObject({ desiredRevision: 1, sources,
      sourceFacts: { direct: { firstPresence: { [machineSetupItemKeyV1(item)]: 'present' } } } });
    const replacement = { ...item, selection: { ...item.selection, inputs: {
      package: { manager: 'apt', apt: { name: 'jq', version: '1.0' } },
    } } };
    expect(await fixture.machineSetupPlan({ input: { ...target, mode: 'effects',
      sources: [{ kind: 'direct', setup: { items: [item, replacement] } }] },
      context: fixture.context('machines.setup.plan') })).toMatchObject({ ok: false, errorCode: 'machine_setup_conflict' });
    const removal = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources: [{ kind: 'direct', setup: {} }], mode: 'effects', removeItemKeys: [] },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(removal.removalPlans).toEqual([]);
    const nativeEffects = fixture.rootLaunches.length;
    expect(await fixture.machineSetupRemove({ input: { ...target, desiredRevision: removal.desiredRevision,
      sources: removal.sources, exclusions: removal.exclusions, removeItemKeys: [], removalPlans: [] },
      context: fixture.context('machines.setup.remove') })).toMatchObject({ operationId: expect.any(String) });
    const removed = MachineSetupPlanResultV1Schema.parse(await read());
    expect(removed).toMatchObject({ desiredRevision: 2, support: [] });
    expect(removed.sources).toEqual([{ kind: 'direct', setup: {} }]);
    expect((await fixture.readInstalled()).installed).toBe(true);
    expect(fixture.rootLaunches).toHaveLength(nativeEffects);
    const next = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources: [{ kind: 'direct', setup: { items: [replacement] } }], mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { ...target, desiredRevision: next.desiredRevision,
      sources: next.sources, exclusions: next.exclusions, recipePlans: next.recipePlans ?? [] },
      context: fixture.context('machines.setup.apply', 'replacement-apply') })).toMatchObject({ operationId: expect.any(String) });
    expect(MachineSetupPlanResultV1Schema.parse(await read())).toMatchObject({
      desiredRevision: 3, sources: [{ kind: 'direct', setup: { items: [replacement] } }],
    });
  });
  it.each([['plain', false], ['plain', true], ['e2ee', false], ['e2ee', true]] as const)('continues the frozen reviewed Workflow setup after partial publication (%s, recipes %s)', async (accountEncryptionMode, withRecipes) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode });
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    const sources = [{ kind: 'direct' as const, setup: { ...(withRecipes ? { items: fixture.sources[0]!.setup.items } : {}), scripts: [
      { body: 'printf FIRST', affects: 'none' as const }, { body: 'exit 23', affects: 'none' as const },
      { body: 'printf THIRD', affects: 'none' as const },
    ] } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan'),
    }));
    const input = { ...target, desiredRevision: plan.desiredRevision, sources: plan.sources,
      exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] };
    nativeTerminal.onLaunch = () => queueMicrotask(() =>
      nativeTerminal.exit?.(nativeTerminal.launches.at(-1)?.args.at(-1) === 'exit 23' ? 23 : 0));
    expect(await fixture.apply({ input, context: fixture.context('machines.setup.apply', 'first') }))
      .toMatchObject({ ok: false, errorCode: 'machine_setup_setup_failed' });
    const recipeEffects = fixture.rootLaunches.length;
    expect(await fixture.apply({ input, context: fixture.context('machines.setup.apply', 'stale-ordinary') }))
      .toMatchObject({ ok: false, errorCode: 'plan_changed' });
    const baseRetryContext = fixture.context('machines.setup.apply', 'retry');
    const authorization = baseRetryContext.externalActionExecutionAuthorization!;
    const retryContext = { ...baseRetryContext, externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding,
      workflowActionOrigin: { runId: 'retained-setup', requestId: 'retry' } } } };
    nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(0));
    expect(await fixture.apply({ input, context: retryContext })).toMatchObject({ operationId: expect.any(String) });
    expect(nativeTerminal.launches.map(launch => launch.args.at(-1)))
      .toEqual(['printf FIRST', 'exit 23', 'exit 23', 'printf THIRD']);
    expect(fixture.rootLaunches).toHaveLength(recipeEffects);
    // A stale frozen input cannot replace a later deliberate desired edit.
    const completed = await fixture.client.getMachineSetupDesiredSnapshot();
    if (completed.status !== 'ready') throw new Error('Completed setup desired state unavailable');
    await fixture.client.captureMachineSetupDesired().apply({
      expectedDesiredRevision: completed.policy.revision,
      sources: [{ kind: 'direct', setup: {} }], exclusions: [],
    });
    const editedContext = { ...fixture.context('machines.setup.apply', 'after-edit'), externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding,
      requestId: 'after-edit', workflowActionOrigin: { runId: 'retained-setup', requestId: 'after-edit' } } } };
    expect(await fixture.apply({ input, context: editedContext })).toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
  it.each([['plain', false], ['plain', true], ['e2ee', false], ['e2ee', true]] as const)('recovers only unfinished scripts after a confirmed failed step (%s, update %s)', async (accountEncryptionMode, update) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode });
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    nativeTerminal.onLaunch = () => {
      const body = nativeTerminal.launches.at(-1)?.args.at(-1);
      queueMicrotask(() => nativeTerminal.exit?.(body === 'exit 23' ? 23 : 0));
    };
    const scripts = [{ body: 'printf FIRST', affects: 'none' as const },
      { body: 'exit 23', affects: 'none' as const }, { body: 'printf THIRD', affects: 'none' as const }];
    const sources = [{ kind: 'direct' as const, setup: { scripts } }];
    const apply = async (next: typeof sources, requestId: string) => {
      const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
        input: { ...target, sources: next, mode: 'effects', ...(update && requestId !== 'first-failure' ? { removeItemKeys: [] } : {}) },
        context: fixture.context('machines.setup.plan'),
      }));
      return fixture.apply({ input: { ...target, desiredRevision: plan.desiredRevision,
        sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [],
        ...(plan.removeItemKeys === undefined ? {} : { removeItemKeys: plan.removeItemKeys }) },
        context: fixture.context('machines.setup.apply', requestId) });
    };
    expect(await apply(sources, 'first-failure')).toMatchObject({ ok: false,
      errorCode: 'machine_setup_setup_failed', details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23 } });
    expect(await apply(sources, 'unchanged-recovery')).toMatchObject({ ok: false,
      errorCode: 'machine_setup_setup_failed', details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23 } });
    expect(nativeTerminal.launches.map(launch => launch.args.at(-1))).toEqual(['printf FIRST', 'exit 23', 'exit 23']);
    const corrected = [{ kind: 'direct' as const, setup: { scripts: [scripts[0]!, { body: 'printf FIXED', affects: 'none' as const }, scripts[2]!] } }];
    expect(await apply(corrected, 'corrected-recovery')).toMatchObject({ operationId: expect.any(String) });
    expect(nativeTerminal.launches.map(launch => launch.args.at(-1)))
      .toEqual(['printf FIRST', 'exit 23', 'exit 23', 'printf FIXED', 'printf THIRD']);
    const saved = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: target, context: fixture.context('machines.setup.plan'),
    }));
    expect(saved.sources).toEqual(corrected);
    expect(saved.sourceFacts?.direct?.pendingScripts).toBeUndefined();
    if (!update) {
      expect(await apply(corrected, 'explicit-full-reapply')).toMatchObject({ operationId: expect.any(String) });
      expect(nativeTerminal.launches.slice(-3).map(launch => launch.args.at(-1)))
        .toEqual(['printf FIRST', 'printf FIXED', 'printf THIRD']);
    }
  });
  it('publishes successful Apply inventory once and reuses it on inert current-copy reads', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    const commandsAfterApply = fixture.nativeCommands.length;
    for (let read = 0; read < 2; read++) {
      expect(await fixture.machineSetupPlan({ input: { homeId: 'srv_home', machineId: fixture.machine.id },
        context: fixture.context('machines.setup.plan') })).toMatchObject({
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }],
      });
    }
    await fixture.client.updateDaemonState(state => {
      if (!state?.setup) throw new Error('Apply must publish its inventory');
      return { ...state, setup: { ...state.setup, desiredRevision: state.setup.desiredRevision - 1 } };
    });
    expect(await fixture.machineSetupPlan({ input: { homeId: 'srv_home', machineId: fixture.machine.id },
      context: fixture.context('machines.setup.plan') })).toMatchObject({
      support: [{ sourceIndex: 0, itemIndex: 0, status: 'unverifiable' }],
    });
    expect(fixture.nativeCommands).toHaveLength(commandsAfterApply);
  });
  it.each([false, true])('binds native Apply to the installed recipe plan (tampered: %s)', async tampered => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    const recipePlans = (plan.recipePlans ?? []).map(entry => {
      if (!tampered) return entry;
      const { v: _version, planDigest: _digest, ...contents } = entry.plan;
      return { ...entry, plan: createMachineSetupEffectPlan({ ...contents,
        steps: [...contents.steps, { id: 'unreviewed-script', kind: 'script', shell: 'sh', body: 'true\n' }],
        nativeFacts: [...contents.nativeFacts, { stepId: 'unreviewed-script', status: 'drifted', facts: {} }],
      }) };
    });
    expect(recipePlans).toHaveLength(1);
    const result = await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: [], recipePlans },
      context: fixture.context('machines.setup.apply') });
    if (tampered) {
      expect(result).toMatchObject({ ok: false, errorCode: 'plan_changed' });
      expect(fixture.rootLaunches).toEqual([]);
      expect(fixture.metadataWrites).toEqual([]);
    } else {
      expect(result).toMatchObject({ operationId: expect.any(String) });
      expect((await fixture.readInstalled()).installed).toBe(true);
    }
  });
  it.each(['admission', 'installation', 'credentials'] as const)('retains the installed runtime %s refusal in a managed Plan', async reason => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const admittedContext = fixture.context('machines.setup.plan');
    const { machineAdmission: _machineAdmission, ...unadmittedContext } = admittedContext;
    const context = { ...(reason === 'admission' ? unadmittedContext : admittedContext),
      externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
      ...admittedContext.externalActionExecutionAuthorization,
      binding: { ...admittedContext.externalActionExecutionAuthorization!.binding, managedContinuation: {
        managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: 'b'.repeat(43),
      } },
    }) };
    if (reason === 'installation') osStore.identity = null;
    else if (reason === 'credentials') osStore.credentials = null;
    const executor = fixture.createExecutor(fixture.credentials, {
      machineSetupPlan: createMachineSetupPlanAction({ apiMachine: fixture.client,
        machineId: fixture.machine.id, homeId: 'srv_home', installation: fixture.installation }),
    });
    expect(await executor.execute('machines.setup.plan', { homeId: 'srv_home', machineId: fixture.machine.id,
      sources: fixture.sources, mode: 'effects' }, context)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
      details: { kind: 'machineSetup', failure: { kind: 'target_unavailable', phase: 'machine_setup_target',
        branch: 'installed_runtime', reason } } });
    expect(fixture.rootLaunches).toEqual([]);
    expect(fixture.metadataWrites).toEqual([]);
  });
  it.each(['plain', 'e2ee'] as const)('keeps detached opaque preset items local through Apply and frozen Workflow retry (%s)', async accountEncryptionMode => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode });
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    const items = fixture.sources[0]!.setup.items!;
    const local = { kind: 'accountPreset' as const, presetId: 'private-retained', presetRevision: 3,
      contentEncryptionMode: accountEncryptionMode, setup: { items } };
    await fixture.client.captureMachineSetupDesired().apply({ expectedDesiredRevision: 0,
      sources: [local, { kind: 'direct', setup: {} }], exclusions: [] });
    const sources = [{ kind: 'direct' as const, setup: { scripts: [{ body: 'exit 23', affects: 'none' as const }] } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan'),
    }));
    // This signed Home input carries the original public proposal. Kept private
    // items are normalized only inside the daemon's desired metadata owner.
    expect(plan.sources).toEqual(sources);
    const input = { ...target, desiredRevision: plan.desiredRevision, sources: plan.sources,
      exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] };
    nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(23));
    expect(await fixture.apply({ input, context: fixture.context('machines.setup.apply', 'first-detach') }))
      .toMatchObject({ ok: false, errorCode: 'machine_setup_setup_failed' });
    const current = await fixture.client.getMachineSetupDesiredSnapshot();
    expect(current).toMatchObject({ status: 'ready', policy: { sources: [{ kind: 'direct', setup: { items } }] } });
    expect(await fixture.apply({ input, context: fixture.context('machines.setup.apply', 'stale-detach') }))
      .toMatchObject({ ok: false, errorCode: 'plan_changed' });
    const context = fixture.context('machines.setup.apply', 'retry-detach');
    const authorization = context.externalActionExecutionAuthorization!;
    const retry = { ...context, externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding,
      workflowActionOrigin: { runId: 'retained-detach', requestId: 'retry-detach' } } } };
    nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(0));
    expect(await fixture.apply({ input, context: retry })).toMatchObject({ operationId: expect.any(String) });
    const completed = await fixture.client.getMachineSetupDesiredSnapshot();
    expect(completed).toMatchObject({ status: 'ready', policy: { sources: [{ kind: 'direct', setup: { items } }] } });
    if (completed.status !== 'ready') throw new Error('Missing completed desired state');
    expect(completed.policy.pendingScriptSources).toBeUndefined();
    await fixture.client.captureMachineSetupDesired().apply({ expectedDesiredRevision: completed.policy.revision,
      sources: [{ kind: 'direct', setup: { items, scripts: [{ body: 'changed', affects: 'none' }] } }], exclusions: [] });
    const afterEdit = fixture.context('machines.setup.apply', 'after-detach-edit');
    expect(await fixture.apply({ input, context: { ...afterEdit, externalActionExecutionAuthorization: {
      ...afterEdit.externalActionExecutionAuthorization!, binding: { ...afterEdit.externalActionExecutionAuthorization!.binding,
        workflowActionOrigin: { runId: 'retained-detach', requestId: 'after-detach-edit' } } } } }))
      .toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
  it('returns the exact resolved opaque preset projection beside Plan without sending its setup to Home', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    const opaque = { kind: 'accountPresetOpaque' as const, presetId: 'historical-preset', presetRevision: 4,
      contentEncryptionMode: 'plain' as const };
    const direct = { kind: 'direct' as const, setup: {} };
    const sources = [opaque, direct];
    const resolvedSources = [{ ...opaque, presetContent: { content: { t: 'plain' as const, v: { v: 1,
      name: 'Historical private setup', setup: { scripts: [{ body: 'private setup', affects: 'none' as const }] } } },
      recipientEnvelope: null } }, direct];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/machines/setup/resolve');
      expect(body).toEqual({ homeId: 'srv_home', machineId: fixture.machine.id,
        candidatePreset: { presetId: opaque.presetId, presetRevision: opaque.presetRevision } });
      return { status: 200, data: { sources: resolvedSources } };
    });
    const plan = MachineSetupPlanResultV1Schema.parse(await createMachineSetupPlanAction({ apiMachine: fixture.client,
      machineId: fixture.machine.id, homeId: 'srv_home', installation: fixture.installation })({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'check' },
      context: fixture.context('machines.setup.plan'),
    }));

    expect(plan.sources).toEqual(sources);
    expect(plan.resolvedSources).toEqual(resolvedSources);
    expect(machineSetupApplyTargetFromPlanV1({ homeId: 'srv_home', machineId: fixture.machine.id }, plan)).not.toHaveProperty('resolvedSources');
    expect(JSON.stringify(post.mock.calls)).not.toContain('private setup');
  });
  it('reviews an addressed preset candidate without changing the attached desired copy', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    const local = { kind: 'accountPreset' as const, presetId: 'candidate-preset', presetRevision: 3, setupRevision: 1,
      contentEncryptionMode: 'plain' as const, setup: { scripts: [{ body: 'echo incumbent', affects: 'none' as const }] } };
    const retained = { ...local, presetId: 'unreadable-retained', presetRevision: 1, setup: {} };
    const direct = { kind: 'direct' as const, setup: {} };
    const target = { homeId: 'srv_home', machineId: fixture.machine.id };
    nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(0));
    const control = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { ...target, mode: 'effects', sources: [{ kind: 'direct', setup: {
        scripts: [{ body: 'printf CONTROL', affects: 'none' }] } }] }, context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: machineSetupApplyTargetFromPlanV1(target, control),
      context: fixture.context('machines.setup.apply', 'known-good-control') })).toMatchObject({ operationId: expect.any(String) });
    expect(nativeTerminal.launches).toHaveLength(1);
    await fixture.client.captureMachineSetupDesired().apply({ expectedDesiredRevision: 1, sources: [local, retained, direct], exclusions: [] });
    const before = await fixture.client.getMachineSetupDesiredSnapshot();
    const candidate = { kind: 'accountPresetOpaque' as const, presetId: local.presetId, presetRevision: 4, setupRevision: 2,
      contentEncryptionMode: 'plain' as const };
    const candidatePreset = { presetId: candidate.presetId, presetRevision: candidate.presetRevision };
    const sources = [candidate, { kind: 'accountPresetOpaque' as const, presetId: retained.presetId,
      presetRevision: retained.presetRevision, setupRevision: retained.setupRevision, contentEncryptionMode: retained.contentEncryptionMode }, direct];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/machines/setup/resolve');
      if (typeof body === 'object' && body !== null && 'purpose' in body) {
        expect(body).toEqual({ homeId: 'srv_home', machineId: fixture.machine.id, purpose: 'creationOrigin',
          candidates: sources.filter(source => source.kind === 'accountPresetOpaque') });
        return { status: 200, data: { purpose: 'creationOrigin' } };
      }
      expect(body).toEqual({ homeId: 'srv_home', machineId: fixture.machine.id, candidatePreset });
      return { status: 200, data: { sources: [{ ...candidate, presetContent: {
        content: { t: 'plain', v: { v: 1, name: 'Candidate', setup: { scripts: [{ body: 'echo candidate', affects: 'none' }] } } },
        recipientEnvelope: null } }, direct] } };
    });
    onTestFinished(() => post.mockRestore());
    const result = await fixture.createExecutor(fixture.credentials).execute('machines.setup.plan', {
      homeId: 'srv_home', machineId: fixture.machine.id, candidatePreset, mode: 'effects',
    }, fixture.context('machines.setup.plan'));
    expect(result).toMatchObject({ ok: true, result: { sources, desiredRevision: 2 } });
    expect(await fixture.client.getMachineSetupDesiredSnapshot()).toEqual(before);
    expect(fixture.rootLaunches).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    const plan = MachineSetupPlanResultV1Schema.parse(result.ok ? result.result : null);
    expect(await fixture.apply({ input: machineSetupApplyTargetFromPlanV1(target, plan),
      context: fixture.context('machines.setup.apply', 'reviewed-candidate') })).toMatchObject({ operationId: expect.any(String) });
    expect(await fixture.client.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready', policy: {
      revision: 3, sources: [{ kind: 'accountPreset', presetId: candidate.presetId,
        presetRevision: 4, setupRevision: 2 }, retained, direct],
    } });
    expect(nativeTerminal.launches).toHaveLength(2);
    expect(post).toHaveBeenCalledTimes(3);
  });
  it('checks the admitted local copy without re-reading its preset authority', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', accountEncryptionMode: 'plain' });
    const local = { kind: 'accountPreset' as const, presetId: 'retained-preset', presetRevision: 3,
      setupRevision: 1, contentEncryptionMode: 'plain' as const, setup: {} };
    const direct = { kind: 'direct' as const, setup: {} };
    await fixture.client.captureMachineSetupDesired().apply({ expectedDesiredRevision: 0, sources: [local, direct], exclusions: [] });
    const before = await fixture.client.getMachineSetupDesiredSnapshot();
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Preset authority is unavailable'));
    onTestFinished(() => post.mockRestore());
    const result = await createMachineSetupPlanAction({ apiMachine: fixture.client, machineId: fixture.machine.id,
      homeId: 'srv_home', installation: fixture.installation })({ input: { homeId: 'srv_home', machineId: fixture.machine.id, mode: 'check' },
      context: fixture.context('machines.setup.plan') });
    expect(result).toMatchObject({ desiredRevision: 1, sources: [{ kind: 'accountPresetOpaque', presetId: local.presetId,
      presetRevision: 3, setupRevision: 1 }, direct] });
    expect(await fixture.client.getMachineSetupDesiredSnapshot()).toEqual(before);
    expect(post).not.toHaveBeenCalled();
    expect(fixture.rootLaunches).toEqual([]);
  });
  it.each([
    { unavailable: 'locks', present: false, mode: 'plain' },
    { unavailable: 'presence', present: false, mode: 'plain' },
    { unavailable: 'presence', present: false, mode: 'e2ee' },
    { unavailable: 'locks', present: true, mode: 'plain' },
    { unavailable: 'presence', present: true, mode: 'plain' },
  ] as const)('retains executing pre-install presence for Remove when $unavailable is unavailable ($present, $mode)', async ({ unavailable, present, mode }) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: present ? 'first-present' : 'first-absent',
      accountEncryptionMode: mode, unprivilegedPackageFactUnavailable: unavailable });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(plan.recipePlans?.[0]?.plan.nativeFacts[0]?.status).toBe('unavailable');
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    const item = fixture.sources[0]!.setup.items![0]!;
    if (item.kind === 'app') throw new Error('Expected the native package recipe');
    const itemKey = machineSetupItemKeyV1(item);
    expect(fixture.machine.metadata?.setup?.sourceFacts?.direct?.firstPresence?.[itemKey]).toBe(present ? 'present' : 'absent');
    expect((await fixture.readInstalled()).installed).toBe(true);
    const removal = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: [{ kind: 'direct', setup: {} }], mode: 'effects',
        removeItemKeys: present ? [] : [itemKey] }, context: fixture.context('machines.setup.plan'),
    }));
    if (present) {
      expect(removal.removalOffers).toContainEqual(expect.objectContaining({ itemKey, status: 'notEligible', reason: 'preExisting' }));
      expect(removal.removalPlans).toEqual([]);
    } else {
      expect(removal.removalPlans).toHaveLength(1);
      expect(await fixture.machineSetupRemove({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
        desiredRevision: removal.desiredRevision, sources: removal.sources, exclusions: removal.exclusions,
        removeItemKeys: [itemKey], removalPlans: removal.removalPlans ?? [] }, context: fixture.context('machines.setup.remove') }))
        .toMatchObject({ operationId: expect.any(String) });
      expect((await fixture.readInstalled()).installed).toBe(false);
      const afterRemoval = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
        input: { homeId: 'srv_home', machineId: fixture.machine.id,
          sources: [{ kind: 'direct', setup: {} }], mode: 'effects' },
        context: fixture.context('machines.setup.plan'),
      }));
      expect(afterRemoval.removalOffers ?? []).not.toContainEqual(expect.objectContaining({ itemKey, status: 'eligible' }));
      expect(afterRemoval.removalPlans ?? []).toEqual([]);
    }
  });
  it('checks and publishes OS updates through Plan without changing desired Software or loading recipes', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const commands: string[] = [];
    const planAction = createMachineSetupPlanAction({ apiMachine: fixture.client,
      machineId: fixture.machine.id, homeId: 'srv_home', runNative: async command => {
        commands.push(command.executable);
        if (command.executable === 'apt-get') return { code: 0, stdout: 'apt 2.6', stderr: '' };
        if (command.executable === 'python3') return { code: 0, stdout: JSON.stringify({ architecture: 'amd64', packages: [
          { name: 'jq', version: '1.0', architecture: 'amd64', security: true },
        ] }), stderr: '' };
        if (command.executable === 'dpkg-query') return { code: 0,
          stdout: 'jq\tinstall ok installed\t0.9\tamd64\n', stderr: '' };
        if (command.executable === 'test') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`Unexpected native read: ${command.executable}`);
      } });
    const before = fixture.machine.metadata?.setup;
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      mode: 'check', updates: { scope: 'all' } });
    const rawResult = await planAction({ input, context: fixture.context('machines.setup.plan') });
    expect(rawResult).not.toHaveProperty('errorCode');
    const result = MachineSetupPlanResultV1Schema.parse(rawResult);
    expect(result).toMatchObject({ updates: { observation: {
      status: 'drifted', backend: 'apt', pendingAll: 1, pendingSecurity: 1, rebootNeeded: true,
    } } });
    expect(fixture.machine.daemonState?.setup?.updates).toEqual(result.updates?.observation);
    expect(fixture.machine.metadata?.setup).toEqual(before);
    expect(fixture.metadataWrites).toHaveLength(0);
    expect(commands).toEqual(['apt-get', 'python3', 'dpkg-query', 'test']);
  });
  it('observes pending updates once after native Software settlement and publishes the reboot fact', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(fixture.machine.daemonState?.setup?.updates).toEqual({ status: 'satisfied', backend: 'apt',
      pendingAll: 0, pendingSecurity: 0, rebootNeeded: false, checkedAt: expect.any(Number) });
    expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ installed: true, updatesChecks: 1 });
  });
  it.each([1, 3])('consumes one admitted snapshot without desired/currentness rereads across %i script steps', async steps => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const { client, machine } = fixture;
    const sources = [{ kind: 'direct' as const, setup: { scripts: Array.from({ length: steps }, (_, index) => ({
      body: `echo step-${index}`, affects: 'none' as const,
    })) } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: machine.id, sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    let desiredReads = 0;
    let runtimeChecks = 0;
    // Observe the real captured content/runtime ports without replacing their
    // decisions. The fixture substitutes only Home IO, filesystem and PTY IO.
    const capture = client.captureMachineSetupDesired.bind(client);
    const desiredObservation = vi.spyOn(client, 'captureMachineSetupDesired').mockImplementation(() => {
      const captured = capture();
      return { ...captured, read: async () => { desiredReads++; return captured.read(); } };
    });
    const resolveRuntime = client.resolveMachineSetupRuntime.bind(client);
    const runtimeObservation = vi.spyOn(client, 'resolveMachineSetupRuntime').mockImplementation(async ingress => {
      const runtime = await resolveRuntime(ingress);
      return runtime && { ...runtime, isCurrent: async () => {
        runtimeChecks++;
        return runtime.isCurrent ? runtime.isCurrent() : false;
      } };
    });
    const stepReads: Array<{ desired: number; currentness: number }> = [];
    nativeTerminal.onLaunch = () => { stepReads.push({ desired: desiredReads, currentness: runtimeChecks }); };
    nativeTerminal.autoExit = true;
    onTestFinished(() => {
      nativeTerminal.onLaunch = undefined;
      nativeTerminal.autoExit = false;
      desiredObservation.mockRestore(); runtimeObservation.mockRestore();
    });
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(stepReads).toEqual(Array.from({ length: steps }, () => ({ desired: 1, currentness: 1 })));
    expect({ desired: desiredReads, currentness: runtimeChecks }).toEqual({ desired: 1, currentness: 1 });
    expect(machine.metadata?.setup?.sources).toEqual(plan.sources);
    expect(fixture.metadataWrites).toHaveLength(1);
  });

  it('applies a secret-backed script despite an unrelated ambient Account publication', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const resourceId = 'setup-script-secret';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const secretValue = 'fixture-script-material';
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
      resourceId, encryptionMode: 'plain',
      entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Setup token', kind: 'token',
        ownerAccountId: 'alice', revision: 3, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Setup token', kind: 'token', value: secretValue } }),
      recipientEnvelope: null,
    }] });
    let publications = 0;
    fixture.setHomeRead(url => {
      if (new URL(url).pathname !== '/v1/account/saved-secrets/resources/materials') return undefined;
      const current = getActiveAccountSettingsSnapshot()!;
      commitActiveAccountSettingsSnapshot({ ...current, settingsVersion: current.settingsVersion + 1,
        settings: accountSettingsParse({ ...current.settings, preferredLanguage: 'fr' }) });
      publications++;
      return { status: 200, data: materials };
    });
    const sources = [{ kind: 'direct' as const, setup: {
      scripts: [{ body: 'test -n "$SETUP_SECRET"', affects: 'none' as const }],
      secretRefs: { v: 1 as const, bindings: { SETUP_SECRET: { ref, revision: 3 } } },
    } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    nativeTerminal.autoExit = true;
    onTestFinished(() => { nativeTerminal.autoExit = false; });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(fixture.credentials),
      settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    onTestFinished(resetActiveAccountSettingsSnapshotForTests);
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(nativeTerminal.launches).toHaveLength(1);
    expect(nativeTerminal.launches[0]?.options.env?.SETUP_SECRET).toBe(secretValue);
    expect(nativeTerminal.launches[0]?.args.join(' ')).not.toContain(secretValue);
    expect(fixture.machine.metadata?.setup?.sources).toEqual(plan.sources);
    expect(publications).toBeGreaterThan(0);
  });

  it('stops the admitted Apply on local cancellation before another step or desired publication', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const sources = [{ kind: 'direct' as const, setup: { scripts: [
      { body: 'echo first', affects: 'none' as const }, { body: 'echo must-not-run', affects: 'none' as const },
    ] } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    const controller = new AbortController();
    nativeTerminal.autoExit = true;
    nativeTerminal.onLaunch = () => { queueMicrotask(() => controller.abort()); };
    onTestFinished(() => { nativeTerminal.autoExit = false; nativeTerminal.onLaunch = undefined; });
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: { ...fixture.context('machines.setup.apply'), signal: controller.signal } }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(nativeTerminal.launches).toHaveLength(1);
    expect(fixture.metadataWrites).toHaveLength(0);
  });
});
