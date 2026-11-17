import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  encodeExternalActionResolvedTargetV1, sealExternalActionRequestV2, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ManagedMachineActionOutputSchemasV1, ManagedControllerContextOutputV1Schema,
  unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { readCredentialEpochFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { addFriend, fetchAccountId, setUsername } from '../../src/testkit/socialFriends';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';

it('TH.J4 admits Check now by the current custodian of another creator’s Machine and preserves wrong-signer and revoked-epoch refusals', async () => {
  const image = process.env.HAPPIER_TEST_SANDBOX_IMAGE;
  if (!image) throw new Error('Supply an existing Docker image with sh and tar; this journey does not download images');
  const testDir = createRunDirs({ runLabel: 'custodian-inspect' }).testDir(randomUUID());
  // This journey needs a bound resource, never a second enrolled guest. The
  // executable boundary intentionally refuses bootstrap after real allocation.
  const payloadRoot = join(testDir, 'non-enrolling-guest-payload');
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(join(payloadRoot, 'happier'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'custodian-inspect',
    captureEnvironmentKeys: [], logFullStdin: true });
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  let managedId: string | undefined;
  try {
    fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', guestReachableHome: true, serverEnv: {
      DATABASE_URL: postgres.homeDatabaseUrl,
      HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1', HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
    } });
    const custodian = await fixture.createAccount('machine-custodian');
    const creator = await fixture.createAccount('machine-creator');
    const controllerMachine = await fixture.enrollDaemon(custodian, { env: {
      HAPPIER_CLAUDE_PATH: agent.executablePath, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payloadRoot,
    } });
    const control = await fixture.assertKnownGoodSessionControl(custodian, controllerMachine);
    const prompt = 'Confirm the managed Check now fixture reaches its Agent.';
    expect(await custodian.execute('session.message.send', { sessionId: control.sessionId, message: prompt }))
      .toMatchObject({ ok: true });
    await waitForFakeClaudeUserText(agent.logPath, text => text.includes(prompt), { invocationId: 'custodian-inspect' });
    console.info('TH.J4 known-good CLI/Home/PostgreSQL/daemon/Agent control passed');
    const installation = MachineInstallationIdentityV1Schema.parse(JSON.parse(
      await readFile(join(controllerMachine.homeDir, 'installation-identity.json'), 'utf8')));
    const controller = { machineId: controllerMachine.target.machineId, installationId: installation.installationId };
    const act = async (account: typeof custodian, actionId: ActionId, input: unknown) => {
      const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId } });
      if (!result.ok) throw new Error(`${actionId} refused (${result.errorCode}); cause=${JSON.stringify(result.failureCause)}`);
      return result.result;
    };
    const creatorId = await fetchAccountId(fixture.server.baseUrl, creator.credentials.token);
    const custodianId = await fetchAccountId(fixture.server.baseUrl, custodian.credentials.token);
    // New cross-Account shares require an accepted friend or teammate; exercise
    // that public prerequisite before expecting the Machine grant to exist.
    await setUsername(fixture.server.baseUrl, custodian.credentials.token, 'inspect_custodian');
    await setUsername(fixture.server.baseUrl, creator.credentials.token, 'inspect_creator');
    await addFriend(fixture.server.baseUrl, custodian.credentials.token, creatorId);
    await addFriend(fixture.server.baseUrl, creator.credentials.token, custodianId);
    expect(await act(custodian, 'machines.access.grant.set', { ...controllerMachine.target,
      principal: { kind: 'account', accountId: creatorId }, level: 'admin' }))
      .toMatchObject({ kind: 'saved' });
    // Grant writes permission first; key preparation is its existing explicit
    // continuation and readiness remains the Machine access owner's result.
    expect(await act(custodian, 'machines.access.prepareKeys', controllerMachine.target))
      .toMatchObject({ kind: 'prepared' });
    expect(await act(creator, 'machines.access.grants.list', controllerMachine.target))
      .toMatchObject({ access: { accessState: 'ready' } });
    const creation = await creator.executeAsPerson('machines.managed.acquire', {
      selection: { kind: 'one-off', homeId: fixture.serverId, controller,
        launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
          name: 'Cross-creator inspection', choices: { runtime: 'docker', configuration: { kind: 'image', image } } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } },
      { presentUserConfirmation: { actionId: 'machines.managed.acquire' } });
    if (!creation.ok) throw new Error(`Managed fixture acquisition refused (${creation.errorCode}); cause=${JSON.stringify(creation.failureCause)}`);
    const acquired = ManagedMachineActionOutputSchemasV1['machines.managed.acquire'].parse(creation.result);
    managedId = acquired.managedId;
    const input = { homeId: fixture.serverId, managedId };
    let allocation: { state: string; errorCode?: string } | undefined;
    if (acquired.operation) {
      const observed = ActionOperationGetV1ResponseSchema.parse(await act(creator, 'action.operations.get', {
        serverId: fixture.serverId, machineId: controller.machineId,
        operationId: acquired.operation.operationId, waitForTerminal: true,
      }));
      expect(observed.kind).toBe('found');
      if (observed.kind !== 'found') throw new Error('The accepted allocation operation is unavailable');
      allocation = { state: observed.operation.state, errorCode: observed.operation.error?.errorCode };
    }
    const bound = unwrapManagedMachineReadV1(ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(
      await act(custodian, 'machines.managed.get', input)));
    expect(bound.allocation, JSON.stringify(allocation)).toBe('bound');
    // The original regression used the creator's retained job when the
    // custodian inspected a resource whose creator was another Account.
    expect(await custodian.execute('machines.managed.inspect', input,
      { actionRequestId: 'c80d9b41-6e84-4f13-bc93-814c65f8b671' })).toMatchObject({ ok: true });
    console.info('TH.J4 current custodian Check now passed through the real CLI and controller');
    const actionId = 'machines.managed.inspect';
    const tokenEpoch = readCredentialEpochFromToken(custodian.auth.token);
    if (tokenEpoch === null) throw new Error('The real custodian credential has no usable epoch');
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: fixture.serverId, accountId: custodianId, authentication: { kind: 'account', tokenEpoch },
        actionId, requestId: randomUUID(), target: { kind: 'machine', machineId: controller.machineId } },
      input, material: { type: 'dataKey', machineKey: custodian.auth.accountMachineKey }, randomBytes });
    const issued = await fetchJson<unknown>(`${fixture.server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${custodian.auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, machineId: controller.machineId, envelope }),
    });
    expect(issued.status).toBe(200);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.data);
    const path = '/v1/machines/managed/controller/context';
    const body = { ...input, expectedIntentRevision: 0, controller };
    const context = (privateKey: Uint8Array) => fetchJson<unknown>(`${fixture!.server.baseUrl}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json',
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
          effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
          requestId: root.binding.requestId, method: 'POST', path, body, privateKey }),
      },
    });
    const key = new Uint8Array(Buffer.from(installation.privateKey, 'base64url'));
    const current = await context(key);
    expect(current.status).toBe(200);
    expect(ManagedControllerContextOutputV1Schema.parse(current.data).machine.id).toBe(managedId);
    const wrongSigner = await context(tweetnacl.sign.keyPair().secretKey);
    expect(wrongSigner.status).toBe(401);
    expect(wrongSigner.data).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_signature' });
    // Use the public credential owner; no direct epoch edit can manufacture the refusal.
    const revoked = await fetchJson<unknown>(`${fixture.server.baseUrl}${ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1}`, {
      method: 'POST', headers: { Authorization: `Bearer ${custodian.auth.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.data).toMatchObject({ status: 'signed_out' });
    const stale = await context(key);
    expect(stale.status).toBe(401);
    expect(stale.data).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'principal' });
  } finally {
    try { await fixture?.stop(); }
    finally {
      // Revocation intentionally retires controller credentials. Remove only
      // this journey's recorded native allocation after stopping its daemon.
      try {
        if (managedId) {
          const execute = promisify(execFile);
          const found = await execute('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`, '--format', '{{.ID}}']);
          for (const id of found.stdout.trim().split('\n').filter(Boolean)) await execute('docker', ['rm', '--force', id]);
        }
      } finally { await postgres.stop(); }
    }
  }
}, 0);
