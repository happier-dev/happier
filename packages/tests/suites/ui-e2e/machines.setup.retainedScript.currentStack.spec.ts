import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  ActionOperationActionInputSchemasV1,
  ActionOperationActionOutputSchemasV1,
} from '@happier-dev/protocol/actions/specs/actionOperations';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import {
  MachineSetupPlanInputV1Schema,
  MachineSetupPlanResultV1Schema,
  MachineSetupApplyInputV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  MachinePresetActionInputSchemasV1,
  MachinePresetActionOutputSchemasV1,
  machinePresetActionEndpointPathV1,
  type MachinePresetActionIdV1,
  type MachinePresetActionInputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';

import { ensureQaUiUrlHasHmrDisabled, withQaUiBase } from '../../../../scripts/qa/resolveQaUiUrl.mjs';
import { fetchJson } from '../../src/testkit/http';
import {
  resolveCurrentManagedStackPluginUiContext,
  type CurrentManagedStackPluginUiContext,
} from '../../src/testkit/pluginPlatform/currentManagedStackPluginUiQa';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { expectEmbeddedTerminalTranscript } from '../../src/testkit/uiE2e/embeddedTerminalSmoke';
import { gotoDomContentLoadedWithRetries, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

// Attach-only: the QA owner supplies a current loaded Stack, its authenticated
// plain Account, and an otherwise setup-empty owned online daemon Machine.
// The seed supplies valid required creation choices while P20.1c is held; this
// journey never allocates a Machine or invokes those creation choices.
const enabled = process.env.HAPPIER_E2E_MACHINE_SETUP_CURRENT_STACK === '1';

function requiredInput(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`machine_setup_current_stack_prerequisite_missing:${name}`);
  return value;
}

function accountToken(context: CurrentManagedStackPluginUiContext): string {
  const credentials: unknown = JSON.parse(context.authStorage.localStorage.auth_credentials);
  if (!credentials || typeof credentials !== 'object' || !('token' in credentials)
    || typeof credentials.token !== 'string' || !credentials.token.trim()) {
    throw new Error('machine_setup_current_stack_account_token_missing');
  }
  return credentials.token;
}

test.describe('current managed Stack retained Machine setup script', () => {
  test.skip(!enabled, 'Requires explicit HAPPIER_E2E_MACHINE_SETUP_CURRENT_STACK=1 and QA-owned runtime inputs; a skip is not journey evidence.');
  test.describe.configure({ mode: 'serial', timeout: 12 * 60_000 });

  test('retains the admitted CRLF source after editing its Preset and shows both finite tasks in the UI', async ({ page }, testInfo) => {
    // The shared resolver supports auto-discovery for other journeys. This
    // exact-target lane must never use that fallback or inspect other Stacks.
    if (!process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH?.trim()) {
      requiredInput('HAPPIER_QA_STACKS_DIR');
      requiredInput('HAPPIER_QA_STACK_NAME');
    }
    const context = await resolveCurrentManagedStackPluginUiContext();
    const machineId = requiredInput('HAPPIER_E2E_MACHINE_SETUP_MACHINE_ID');
    const seedPath = requiredInput('HAPPIER_E2E_MACHINE_SETUP_PRESET_SEED_PATH');
    expect(machineId, 'The QA owner must select this exact loaded daemon, not another Machine.').toBe(context.daemon.machineId);
    if (!context.account.serverIdentityId) throw new Error('machine_setup_current_stack_home_identity_missing');
    const homeId = context.account.serverIdentityId;
    const token = accountToken(context);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const seed = MachinePresetActionInputSchemasV1['machines.presets.create'].parse(JSON.parse(await readFile(seedPath, 'utf8')));
    expect(seed.homeId).toBe(homeId);
    expect(seed.owner).toEqual({ kind: 'account', accountId: context.account.accountId });
    const nonce = randomUUID();
    const presetId = `machine-setup-qa-${nonce}`;
    const originalSentinel = `HAPPIER_SETUP_ORIGINAL_${nonce}`;
    const editedSentinel = `HAPPIER_SETUP_EDITED_${nonce}`;
    const originalSetup = { scripts: [{ body: `\r\necho ${originalSentinel}\r\n`, affects: 'none' as const }] };
    const editedSetup = { scripts: [{ body: `\r\necho ${editedSentinel}\r\n`, affects: 'none' as const }] };
    const diagnostics = collectBrowserDiagnostics({ page });
    const loadedUiScripts = new Set<string>();
    let pendingApprovalId: string | undefined;
    page.on('response', response => {
      if (response.ok() && response.request().resourceType() === 'script'
        && new URL(response.url()).origin === new URL(context.uiUrl).origin) {
        loadedUiScripts.add(new URL(response.url()).pathname);
      }
    });
    await installAuthBootstrapStorageSnapshot(page, context.authStorage);

    const presetAction = async <T extends MachinePresetActionIdV1>(actionId: T, input: MachinePresetActionInputV1<T>) => {
      const body = MachinePresetActionInputSchemasV1[actionId].parse(input);
      const response = await fetchJson<unknown>(`${context.serverUrl}${machinePresetActionEndpointPathV1(actionId)}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(response.status, `Preset ${actionId} HTTP status`).toBe(200);
      return MachinePresetActionOutputSchemasV1[actionId].parse(response.data);
    };
    // This is the ordinary authenticated Account ingress, not a daemon RPC or
    // injected executor. It supplies no authority, approval, or replay flags.
    const accountAction = async (actionId: string, input: unknown) => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(),
        target: { kind: 'machine', machineId }, input });
      const response = await fetchJson<unknown>(`${context.serverUrl}/v1/actions/${actionId}`, {
        method: 'POST', headers, body: JSON.stringify(request),
      });
      expect(response.status, `${actionId} HTTP status`).toBe(200);
      const envelope = ExternalActionResponseEnvelopeV1Schema.parse(response.data);
      expect(envelope.actionId).toBe(actionId);
      expect(envelope.requestId).toBe(request.requestId);
      if (!envelope.execution.ok) throw new Error(`machine_setup_current_stack_action_refused:${actionId}:${envelope.execution.errorCode}`);
      return { request, result: envelope.execution.result };
    };
    const readCurrent = async () => MachineSetupPlanResultV1Schema.parse((await accountAction('machines.setup.plan',
      MachineSetupPlanInputV1Schema.parse({ homeId, machineId }))).result);
    const visit = async (path: string, expectedPathname: string, requiredTestId: string) => {
      const targetUrl = ensureQaUiUrlHasHmrDisabled(withQaUiBase(context.uiUrl, path));
      await gotoDomContentLoadedWithRetries(page, targetUrl, 180_000);
      await waitForAuthenticatedRouteUi({ page, expectedPathname, requiredTestIds: [requiredTestId], targetUrl, timeoutMs: 180_000 });
    };
    const approve = async (artifactId: string) => {
      const path = `/inbox/approvals/${encodeURIComponent(artifactId)}`;
      await visit(`${path}?serverId=${encodeURIComponent(context.account.uiServerId)}`, path, 'approvals.approve');
      const decision = page.getByTestId('approvals.approve');
      await expect(decision).toBeEnabled();
      await decision.click();
      await expect(decision).toHaveCount(0, { timeout: 120_000 });
      pendingApprovalId = undefined;
    };
    const operationForRequest = async (requestId: string, requireOutput: boolean): Promise<ActionOperationSnapshotV1> => {
      const found: { operation?: ActionOperationSnapshotV1 } = {};
      await expect.poll(async () => {
        let cursor: string | undefined;
        do {
          const input = ActionOperationActionInputSchemasV1['action.operations.list'].parse({ serverId: homeId, machineId,
            ...(cursor ? { cursor } : {}) });
          const listed = ActionOperationActionOutputSchemasV1['action.operations.list'].parse((await accountAction('action.operations.list', input)).result);
          found.operation = listed.items.find(item => item.requestId === requestId && item.actionId === 'machines.setup.apply');
          cursor = listed.nextCursor ?? undefined;
        } while (!found.operation && cursor);
        return found.operation?.operationId ?? null;
      }, { timeout: 120_000, message: 'Approved source Apply must produce its actual retained operation.' }).not.toBeNull();
      if (!found.operation) throw new Error('machine_setup_current_stack_operation_missing');
      const input = ActionOperationActionInputSchemasV1['action.operations.get'].parse({ serverId: homeId, machineId,
        operationId: found.operation.operationId, waitForTerminal: true });
      const settled = ActionOperationActionOutputSchemasV1['action.operations.get'].parse((await accountAction('action.operations.get', input)).result);
      if (settled.kind !== 'found') throw new Error('machine_setup_current_stack_operation_retired');
      expect(settled.operation.state).toBe('succeeded');
      expect(settled.operation.scope).toMatchObject({ accountId: context.account.accountId, machineId });
      if (requireOutput) expect(settled.operation.domainRef).toMatchObject({ kind: 'machineSetup', serverId: homeId, machineId,
        setupTask: { taskKind: 'machine.setup.apply.v1' }, terminalId: expect.any(String) });
      return settled.operation;
    };
    const showOutput = async (operation: ActionOperationSnapshotV1) => {
      await visit('/inbox?view=updates', '/inbox', 'inbox.screen');
      await page.getByTestId(`inbox.action-operation.${operation.operationId}`).click();
      await expect(page.getByTestId('action-operation-detail')).toBeVisible();
      await expectEmbeddedTerminalTranscript(page, 'workspace-embedded', originalSentinel);
      const output = await page.getByTestId('workspace-embedded-terminal-xterm').getAttribute('data-happier-terminal-text');
      expect(output).not.toContain(editedSentinel);
      await testInfo.attach(`setup-output-${operation.operationId}.txt`, { body: Buffer.from(output ?? '', 'utf8'), contentType: 'text/plain' });
      await page.getByTestId('action-operation-done').click();
    };
    const applyCurrent = async (sources: unknown, requireOutput = true) => {
      const current = await readCurrent();
      const planInput = MachineSetupPlanInputV1Schema.parse({ homeId, machineId, sources, mode: 'effects' });
      const prepared = MachineSetupPlanResultV1Schema.parse((await accountAction('machines.setup.plan', planInput)).result);
      expect(prepared.desiredRevision).toBe(current.desiredRevision);
      expect(prepared.sources).toEqual(planInput.sources);
      if (!prepared.recipePlans) throw new Error('machine_setup_current_stack_effect_plans_missing');
      const input = MachineSetupApplyInputV1Schema.parse({ homeId, machineId, targets: [{ homeId, machineId,
        sources: prepared.sources, desiredRevision: prepared.desiredRevision, recipePlans: prepared.recipePlans }] });
      const submitted = await accountAction('machines.setup.apply', input);
      const ask = ActionApprovalRequestCreatedResultSchema.parse(submitted.result);
      expect(ask.actionId).toBe('machines.setup.apply');
      pendingApprovalId = ask.artifactId;
      await approve(ask.artifactId);
      if (!submitted.request.requestId) throw new Error('machine_setup_current_stack_request_identity_missing');
      return operationForRequest(submitted.request.requestId, requireOutput);
    };

    let createdRevision: number | undefined;
    let attachmentMayExist = false;
    let journeyError: Error | undefined;
    try {
      const encryption = await fetchJson<unknown>(`${context.serverUrl}/v1/account/encryption`, { headers });
      expect(encryption.status).toBe(200);
      expect(encryption.data).toMatchObject({ mode: 'plain' });
      const machine = await fetchJson<{ machine: unknown }>(`${context.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`, { headers });
      expect(machine.status).toBe(200);
      const publishedMachine = MachinePublishedRowV1Schema.parse(machine.data.machine);
      expect(publishedMachine).toMatchObject({ id: machineId, kind: 'persistent', active: true,
        revokedAt: null, replacedByMachineId: null,
        access: { accessState: 'ready', resourceMode: 'plain', custodian: { accountId: context.account.accountId } } });
      const before = await readCurrent();
      // Refuse before attaching/running anything if this Machine contains other
      // setup: the authorization is inert stdout only, never a package install,
      // another person's script, a toolchain, or secret materialization.
      expect(before.sources).toEqual([{ kind: 'direct', setup: {} }]);
      const created = await presetAction('machines.presets.create', { ...seed, id: presetId, name: 'Retained script QA', setup: originalSetup });
      if (created.kind !== 'saved') throw new Error(`machine_setup_current_stack_preset_create_${created.kind}`);
      createdRevision = created.preset.revision;
      expect(created.preset.setup).toEqual(originalSetup);

      const machinePath = `/settings/machines/${encodeURIComponent(machineId)}`;
      await visit(`${machinePath}?serverId=${encodeURIComponent(context.account.uiServerId)}`, machinePath, 'machine-detail-menu.trigger');
      await page.getByTestId('machine-detail-menu.trigger').click();
      await page.getByTestId('machine-detail-menu-environment-apply').click();
      await page.getByTestId(`machine-setup-apply.preset:${presetId}`).click();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/v1/actions/machines.setup.apply'
        && value.request().method() === 'POST');
      await expect(page.getByTestId('machine-setup-apply.run')).toBeEnabled();
      attachmentMayExist = true;
      await page.getByTestId('machine-setup-apply.run').click();
      const initial = await response;
      const request = ExternalActionRequestEnvelopeV1Schema.parse(initial.request().postDataJSON());
      const initialApply = MachineSetupApplyInputV1Schema.parse(request.input);
      expect(initialApply).toMatchObject({ homeId, machineId, targets: [{ homeId, machineId,
        desiredRevision: before.desiredRevision, recipePlans: [] }] });
      expect(initialApply.targets).toHaveLength(1);
      expect(initialApply.targets[0]!.sources).toContainEqual({
        kind: 'accountPreset', presetId, presetRevision: createdRevision, setup: originalSetup,
      });
      const initialEnvelope = ExternalActionResponseEnvelopeV1Schema.parse(await initial.json());
      if (!initialEnvelope.execution.ok) throw new Error(`machine_setup_current_stack_initial_apply_${initialEnvelope.execution.errorCode}`);
      const ask = ActionApprovalRequestCreatedResultSchema.parse(initialEnvelope.execution.result);
      expect(ask.actionId).toBe('machines.setup.apply');
      pendingApprovalId = ask.artifactId;
      await expect(page.getByTestId('machine-setup-apply.approval')).toBeVisible();
      // Use the Sheet's real navigation out to its request; approval remains
      // with the native Action owner and the ordinary Inbox review page.
      await page.getByTestId('machine-setup-apply.approval.action').click();
      await expect(page.getByTestId('approvals.approve')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(`/inbox/approvals/${encodeURIComponent(ask.artifactId)}`);
      await page.getByTestId('approvals.approve').click();
      await expect(page.getByTestId('approvals.approve')).toHaveCount(0, { timeout: 120_000 });
      pendingApprovalId = undefined;
      if (!request.requestId) throw new Error('machine_setup_current_stack_request_identity_missing');
      const first = await operationForRequest(request.requestId, true);
      await showOutput(first);

      const edited = await presetAction('machines.presets.update', { homeId, id: presetId, expectedRevision: createdRevision,
        patch: { setup: editedSetup } });
      if (edited.kind !== 'saved') throw new Error(`machine_setup_current_stack_preset_update_${edited.kind}`);
      createdRevision = edited.preset.revision;
      expect(edited.preset.setup).toEqual(editedSetup);
      const current = await readCurrent();
      expect(current.sources.find(source => source.kind === 'accountPreset' && source.presetId === presetId))
        .toEqual(expect.objectContaining({ presetRevision: created.preset.revision, setup: originalSetup }));
      // Reapply exactly the held copies. Reselecting the edited Preset in the
      // Sheet would deliberately replace that copy and prove the wrong flow.
      const second = await applyCurrent(current.sources);
      expect(second.operationId).not.toBe(first.operationId);
      await showOutput(second);
      await testInfo.attach('current-machine-setup-runtime.json', { body: Buffer.from(JSON.stringify({
        stackName: context.stackName, homeId, accountId: context.account.accountId, machineId,
        daemonPid: context.daemon.pid, daemonRuntimeId: context.daemon.runtimeId,
        daemonEntrypoint: context.daemon.runtimeEntrypoint, daemonClosure: context.daemon.distClosureFingerprint,
        uiProducer: context.uiProducer, loadedUiScripts: [...loadedUiScripts],
        operations: [first.operationId, second.operationId],
      }, null, 2)), contentType: 'application/json' });
      expect(loadedUiScripts.size).toBeGreaterThan(0);
    } catch (error) {
      journeyError = appendBrowserDiagnostics(error, diagnostics());
      throw journeyError;
    } finally {
      // Retire only this journey's admitted copy through the same reviewed
      // Action, then archive its exact Preset. No record/terminal deletion or
      // lifecycle reset is used as cleanup.
      const cleanupFailures: unknown[] = [];
      try {
        // An interrupted UI review must not leave this test's open Ask able
        // to attach its source later. Cancellation uses its real owner and
        // never grants approval or bypasses the human decision path above.
        if (pendingApprovalId) {
          const canceled = await accountAction('approval.request.decide', { artifactId: pendingApprovalId, decision: 'cancel' });
          expect(canceled.result).toMatchObject({ status: 'canceled' });
          pendingApprovalId = undefined;
        }
      } catch (error) { cleanupFailures.push(error); }
      try {
        if (attachmentMayExist) {
          const current = await readCurrent();
          const remaining = current.sources.filter(source => source.kind !== 'accountPreset' || source.presetId !== presetId);
          expect(remaining).toEqual([{ kind: 'direct', setup: {} }]);
          if (remaining.length !== current.sources.length) await applyCurrent(remaining, false);
        }
      } catch (error) { cleanupFailures.push(error); }
      try {
        if (createdRevision !== undefined) {
          const archived = await presetAction('machines.presets.archive', { homeId, id: presetId, expectedRevision: createdRevision });
          expect(archived.kind).toBe('saved');
        }
      } catch (error) { cleanupFailures.push(error); }
      if (cleanupFailures.length) {
        const failure = new AggregateError(cleanupFailures, 'Machine setup QA-owned source/Preset cleanup failed.');
        if (journeyError) appendBrowserDiagnostics(journeyError, `${failure.message}\n${cleanupFailures.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`);
        else throw failure;
      }
    }
  });
});
