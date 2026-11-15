import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { packageOs } from '@/testkit/machines/nativeSoftwareOs';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, formatSavedSecretCatalogReferenceV1, sealEncryptedDataKeyEnvelopeV1, sealSavedSecretResourceStoredContentV1, verifyMachineInstallationProof } from '@happier-dev/protocol';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  projectDeploymentPreparationAdmissionV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, MachineConnectorSecretGrantInputV1Schema } from '@happier-dev/deployment-protocol';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { machineConnectorCredentialDirectory, machineConnectorCredentialFilePath } from '@happier-dev/cli-common/machineSetup/credentialFile';
import type { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { tailscaleServer } from '../../../../../packages/plugins/machine-recipes/src/tailscaleServer';
import { exercisePublicPackagePlanApply } from '@/testkit/machines/nativeSoftwareInstallFlow';
import { ActionOperationGetV1ResponseSchema, ActionOperationIdentifierV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === 'linux')('cold Tailscale setup credential bridge', () => {
  it.each([
    { mode: 'plain' as const, grantee: false }, { mode: 'e2ee' as const, grantee: false },
    { mode: 'plain' as const, grantee: true }, { mode: 'e2ee' as const, grantee: true },
  ])('uses only the same Account receiver custody for a remote workflow codec leaf ($mode, grantee=$grantee)', async ({ mode, grantee }) => {
    const credentialIndex = tailscaleServer.steps.findIndex(step => step.id === machineConnectorCredentialDirectory.id);
    expect(credentialIndex).toBeGreaterThan(0);
    await exercisePublicPackagePlanApply('native-confirm', false, async fixture => {
      packageOs.connectorCredentialsDirectory = join(dirname(fixture.statePath), 'connector-credentials');
      const resourceId = 'public-workflow-tailscale-resource';
      const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
      const material = 'public-workflow-private-tailscale-key';
      const resourceDataKey = new Uint8Array(32).fill(39);
      const encryption = fixture.credentials.encryption;
      if (mode === 'e2ee' && encryption?.type !== 'dataKey') throw new Error('Expected receiver content custody');
      const recipientEnvelope = mode === 'e2ee' && encryption?.type === 'dataKey' ? {
        encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey,
          recipientPublicKey: encryption.publicKey, randomBytes })).toString('base64'),
        recipientContentPublicKeyFingerprint: 'receiver-content-fingerprint',
      } : null;
      const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: mode,
        entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Tailscale key', kind: 'token',
          ownerAccountId: 'shared-key-owner', revision: 3, materialStatus: 'ready',
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
        storedContent: mode === 'plain'
          ? sealSavedSecretResourceStoredContentV1({ resourceId, mode, content: { v: 1, name: 'Tailscale key', kind: 'token', value: material } })
          : sealSavedSecretResourceStoredContentV1({ resourceId, mode, resourceDataKey, randomBytes,
            content: { v: 1, name: 'Tailscale key', kind: 'token', value: material } }),
        recipientEnvelope,
      }] });
      // Retain the public-flow Home boundary and specialize only its SavedSecret response.
      const homeGet = vi.mocked(axios.get).getMockImplementation();
      if (!homeGet) throw new Error('Expected native Home HTTP boundary');
      vi.mocked(axios.get).mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/v1/account/saved-secrets/resources/materials'
        ? { status: 200, data: materials } : homeGet(...args));
      let stored: ReturnType<typeof sealMachineSecretGrant> | undefined;
      const grantOperations: string[] = [];
      vi.spyOn(axios, 'request').mockImplementation(async config => {
        const body = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
        expect(new URL(String(config.url)).pathname).toBe(`/v1/deployments/machines/${fixture.machine.id}/connector-secret-grant`);
        expect(body.subject).toMatchObject({ machineId: fixture.machine.id,
          installationId: fixture.installation.installationId, provider: { kind: 'builtin', id: 'tailscale' } });
        grantOperations.push(body.operation);
        if (body.operation === 'set') stored = body.grant;
        if (body.operation === 'remove') stored = undefined;
        return { status: 200, data: { ok: true, ...(stored ? { grant: stored } : {}) } };
      });
      packageOs.runNative = async command => {
        if (command.executable === 'getent') {
          const account = command.args.at(-1);
          return { code: 0, stdout: command.args.includes('passwd')
            ? `${account}:x:${account === 'root' ? 0 : 1001}:${account === 'root' ? 0 : 1001}::/home/happier:/bin/sh\n`
            : `${account}:x:${account === 'root' ? 0 : 1001}:\n`, stderr: '' };
        }
        return null;
      };
      const sources = [{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
        ref: { pluginId: 'com.example.public-tailscale', recipeId: 'tailscale-server', revision: tailscaleServer.revision },
        inputs: { distribution: 'debian-bookworm', joinCredential: { ref, resourceRevision: 3 }, setOperator: false },
      } }] } }];
      const review = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({ input: {
        homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects', sources,
      }, context: fixture.context('machines.setup.plan') }));
      const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, sources: review.sources,
          desiredRevision: review.desiredRevision, recipePlans: review.recipePlans }] });
      const publisherMachineId = 'remote-workflow-publisher';
      const publisherInstallationId = 'remote-workflow-publisher-installation';
      const publisherKeys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
      expect(publisherMachineId).not.toBe(fixture.machine.id);
      const accountId = grantee ? 'grantee' : 'alice';
      const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-setup-parent', binding: {
        accountId, custodianAccountId: 'alice', serverIdentityId: 'srv_home', accountEncryptionMode: mode,
        machineId: publisherMachineId, installationId: publisherInstallationId,
        ...(grantee ? { principalId: accountId, credentialId: randomUUID(), grant: API_TOKEN_FULL_GRANT_V1 }
          : { authentication: { kind: 'account', tokenEpoch: 0 } }),
        actionId: 'machines.setup.apply', requestId: 'home-admitted-parent-request', admittedMachineRole: 'manage',
        target: { kind: 'machine', machineId: publisherMachineId }, requestEnvelopeDigest: 'a'.repeat(43),
      } });
      const reviewedChild = { actionId: 'machines.setup.apply' as const, role: 'setup-invocation',
        inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) };
      const runId = deriveMachineSetupCombinedRunIdV1({ homeId: 'srv_home', accountId,
        requestId: parent.binding.requestId, reviewedChild });
      const requestId = `${runId}/setup-0/0`;
      const context = { surface: 'agent', authority: 'account_automation', runtimeAccountId: accountId,
        actionRequestId: requestId, executionRunWorkflowRunId: runId, externalActionExecutionAuthorization: parent,
        actionCaller: { kind: 'workflowRun', runId, authorization: { principal: grantee
          ? { kind: 'api', accountId, principalId: accountId, credentialId: 'credentialId' in parent.binding ? parent.binding.credentialId : '' }
          : { kind: 'host' }, admittedPermissionCeiling: 'default', externalActionExecutionAuthorization: parent, reviewedChild } },
      } satisfies ActionExecutorContext;
      let childAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
      let codecDelivered = false;
      // Home is the genuine mint/delivery boundary. Keep the real issuer, codec,
      // receiving RPC owner, consent restoration and native credential consumer.
      vi.mocked(axios.post).mockImplementation(async (url, raw) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
        if (path.endsWith('/execution-authorization')) {
          expect(request.workflowActionOrigin).toEqual({ runId, requestId, reviewedChild });
          expect(verifyMachineInstallationProof({ publicKey: publisherKeys.publicKey, proof: request.installationProof!, payload: {
            version: 1, accountId: 'alice', machineId: publisherMachineId, installationId: publisherInstallationId,
            externalActionOrigin: { homeId: 'srv_home', actionId: 'machines.setup.apply', requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.workflowActionOrigin! },
          } })).toBe(true);
          childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-codec-child', binding: {
            ...parent.binding, machineId: fixture.machine.id, installationId: fixture.installation.installationId,
            target: { kind: 'machine', machineId: fixture.machine.id }, requestId,
            workflowActionOrigin: request.workflowActionOrigin,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          } });
          return { status: 200, data: childAuthorization };
        }
        expect(path).toBe('/v1/actions/machines.setup.apply');
        const authorization = request.executionAuthorization;
        if (!authorization) throw new Error('Expected Home child authority');
        const opening = { authorization, machineId: fixture.machine.id, installationId: fixture.installation.installationId,
          serverIdentityId: 'srv_home', installationPrivateKey: fixture.pair.secretKey };
        expect(openManagedControllerActionCodecV1(opening)?.machineKey).toHaveLength(32);
        expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
        codecDelivered = true;
        return { status: 200, data: await fixture.receive({ actionId: 'machines.setup.apply',
          envelope: request.envelope, authorization, authority: 'account_automation' }) };
      });
      const applied = await dispatchOriginalAccountAction({ actionId: 'machines.setup.apply', input, requestId,
        target: { kind: 'machine', machineId: fixture.machine.id }, credentials: fixture.credentials,
        serverHttpBaseUrl: configuration.apiServerUrl, serverIdentityId: 'srv_home',
        installedWorkflow: { context, machineId: publisherMachineId, installationId: publisherInstallationId, privateKey: publisherKeys.secretKey } });
      expect(codecDelivered).toBe(true);
      if (!applied.ok) {
        expect(grantee && applied.errorCode).toBe('credential_unavailable');
        expect(grantOperations).toEqual([]);
        expect(fixture.rootLaunches).toEqual([]);
        return;
      }
      const receipt = applied.result;
      if (!receipt || typeof receipt !== 'object' || !('operationId' in receipt)) throw new Error('Expected native Operation receipt');
      const operationId = ActionOperationIdentifierV1Schema.parse(receipt.operationId);
      const settled = ActionOperationGetV1ResponseSchema.parse(await fixture.operations.handlers.getV2({
        operationId, waitForTerminal: true,
      }, fixture.context('machines.setup.apply')));
      if (grantee) {
        expect(settled).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'credential_unavailable' } } });
        expect(grantOperations).toEqual([]);
        expect(fixture.rootLaunches).toEqual([]);
        return;
      }
      expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      expect(grantOperations.filter(operation => operation === 'set')).toHaveLength(1);
      expect(grantOperations).toContain('read');
      expect(grantOperations.filter(operation => operation === 'remove')).toHaveLength(1);
      expect(stored).toBeUndefined();
      expect(JSON.stringify({ review, applied, settled, diagnostics: fixture.workflowDiagnostic() })).not.toContain(material);
    }, undefined, undefined, mode, undefined, { additionalPlugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: 'com.example.public-tailscale', version: '1.0.0', displayName: 'Public Tailscale fixture', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ ...tailscaleServer, id: 'tailscale-server',
        // Use the real protected file declaration; native join is covered by the adjacent bridge test.
        steps: tailscaleServer.steps.slice(credentialIndex).filter(step => step.id === machineConnectorCredentialDirectory.id || step.id === 'tailscale-credential') }] },
    } }] });
  });
  it.each([false, true])('opens the selected SavedSecret only for admitted Apply and retires its grant and file (join failure: %s)', async joinFails => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(channel.close);
    // Consume the real cold declaration's complete credential/join suffix. The
    // packageSource/package/service prefix has separate native-owner coverage;
    // this journey isolates the new Account → installed-root credential seam.
    const credentialIndex = tailscaleServer.steps.findIndex(step => step.id === machineConnectorCredentialDirectory.id
      || step.id === 'tailscale-credential');
    expect(credentialIndex).toBeGreaterThan(0);
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', serverHttpBaseUrl: channel.serverUrl,
      additionalPlugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: 'com.example.cold-tailscale', version: '1.0.0', displayName: 'Cold Tailscale fixture', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ ...tailscaleServer, id: 'tailscale-server',
        steps: tailscaleServer.steps.slice(credentialIndex) }] },
    } }] });
    packageOs.connectorCredentialsDirectory = join(dirname(fixture.statePath), 'connector-credentials');
    const secretValue = 'composed-tailscale-key-never-public';
    const resourceId = 'tailscale-join-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: 'plain',
      entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Selected Tailscale key', kind: 'token',
        ownerAccountId: 'shared-key-owner', revision: 3, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Selected Tailscale key', kind: 'token', value: secretValue } }), recipientEnvelope: null,
    }] });
    let materialReads = 0;
    fixture.setHomeRead(url => {
      if (new URL(url).pathname !== '/v1/account/saved-secrets/resources/materials') return undefined;
      materialReads++;
      return { status: 200, data: materials };
    });
    let stored: ReturnType<typeof sealMachineSecretGrant> | undefined;
    const grantOperations: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const body = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
      expect(config.url).toBe(`${configuration.apiServerUrl}/v1/deployments/machines/${fixture.machine.id}/connector-secret-grant`);
      expect(body).toMatchObject({ serverId: 'srv_home', hostMachineId: fixture.machine.id,
        hostInstallationId: fixture.installation.installationId,
        subject: { machineId: fixture.machine.id, installationId: fixture.installation.installationId,
          provider: { kind: 'builtin', id: 'tailscale' } } });
      const { proof, ...unsigned } = body;
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: fixture.machine.id,
        installationId: fixture.installation.installationId, accountId: 'alice',
        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(unsigned) } },
        proof, publicKey: fixture.pair.publicKey })).toBe(true);
      expect(config.headers).not.toHaveProperty('Authorization');
      expect(config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('reviewed-software');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'reviewed-software', effectActionId: 'machines.setup.apply',
        target: { kind: 'machine', machineId: fixture.machine.id }, installationId: fixture.installation.installationId,
        requestId: 'machines.setup.apply', method: 'POST', path: new URL(String(config.url)).pathname, body,
        publicKey: fixture.pair.publicKey, signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      expect(JSON.stringify(body)).not.toContain(secretValue);
      grantOperations.push(body.operation);
      if (body.operation === 'set') stored = body.grant;
      if (body.operation === 'read') expect(stored).toBeDefined();
      if (body.operation === 'remove') stored = undefined;
      return { status: 200, data: { ok: true, ...(stored ? { grant: stored } : {}) } };
    });
    let joined = false;
    let online = true;
    const setOnline = async (next: boolean) => {
      online = next;
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
      await writeFile(fixture.statePath, JSON.stringify({ ...state, joined: next }));
    };
    await setOnline(true);
    // Apply's fresh native observation uses the ordinary exec boundary; the
    // elevated interpreter uses the callback below. Both see the same OS state.
    await writeFile(join(dirname(fixture.statePath), 'bin', 'tailscale'), `#!${process.execPath}\n`
      + `import { readFileSync } from 'node:fs';\n`
      + `const state = JSON.parse(readFileSync(${JSON.stringify(fixture.statePath)}, 'utf8'));\n`
      + `if (process.argv[2] !== 'status') process.exitCode = 2;\n`
      + `else process.stdout.write(JSON.stringify({ BackendState: state.joined ? 'Running' : 'Stopped', Self: { Online: !!state.joined } }));\n`,
      { mode: 0o755 });
    const nativeCommands: Array<{ executable: string; args: readonly string[] }> = [];
    const keyFile = machineConnectorCredentialFilePath(fixture.installation.installationId);
    const fileObservations: Array<{ path: string; uid: number; gid: number; mode: number; privateBytesMatch: boolean }> = [];
    packageOs.runNative = async command => {
      nativeCommands.push({ executable: command.executable, args: command.args });
      if (command.executable === 'getent') {
        const account = command.args.at(-1);
        return { code: 0, stdout: command.args.includes('passwd')
          ? `${account}:x:${account === 'root' ? 0 : 1001}:${account === 'root' ? 0 : 1001}::/home/happier:/bin/sh\n`
          : `${account}:x:${account === 'root' ? 0 : 1001}:\n`, stderr: '' };
      }
      if (!command.executable.endsWith('tailscale')) return null;
      if (command.args[0] === 'status') return { code: 0, stdout: JSON.stringify({
        BackendState: online ? 'Running' : 'Stopped', Self: { Online: online },
      }), stderr: '' };
      if (command.args[0] === 'down') await setOnline(false);
      const keyOperand = command.args.find(argument => argument.startsWith('--auth-key=file:'));
      if (keyOperand) {
        const path = keyOperand.slice('--auth-key=file:'.length);
        const stat = await lstat(path);
        fileObservations.push({ path, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777,
          privateBytesMatch: (await readFile(path, 'utf8')) === secretValue });
        if (joinFails) return { code: 1, stdout: '', stderr: '' };
        joined = true;
        await setOnline(true);
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const sources = [{ kind: 'direct' as const, setup: { items: [{ kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.cold-tailscale', recipeId: 'tailscale-server', revision: tailscaleServer.revision },
      inputs: { distribution: 'debian-bookworm', joinCredential: { ref, resourceRevision: 3 }, setOperator: false },
    } }] } }];
    const planned = await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan'),
    });
    expect(planned, JSON.stringify(planned)).toHaveProperty('recipePlans');
    const plan = MachineSetupPlanResultV1Schema.parse(planned);
    expect(plan.recipePlans).toHaveLength(1);
    expect(plan.support).toMatchObject([{ status: 'drifted' }]);
    expect(materialReads).toBe(0);
    expect(grantOperations).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(secretValue);
    // Use the receiving owner's real requester preparation, including Account
    // settings custody and signed HTTP projection. P42 covers a different actor.
    const applyContext = fixture.context('machines.setup.apply');
    const runtime = await fixture.client.resolveMachineSetupRuntime(applyContext);
    if (!runtime?.isCurrent || !applyContext.externalActionExecutionAuthorization)
      throw new Error('Expected installed setup custody');
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe('/v1/actions/machines.setup.apply/execution-authorization/verify');
      return { status: 200, data: { ok: true } };
    });
    const requester = await prepareRequesterAccountActionContext({
      authorization: applyContext.externalActionExecutionAuthorization, purpose: { kind: 'external_action' },
      machineId: fixture.machine.id, installationId: fixture.installation.installationId,
      installationPrivateKey: fixture.pair.secretKey, serverId: configuration.activeServerId,
      serverIdentityId: 'srv_home', serverHttpBaseUrl: configuration.apiServerUrl,
      ownCredentials: fixture.credentials, isCurrent: runtime.isCurrent,
      isCustodyCurrent: runtime.isCustodyCurrent, isRetainedCustodyCurrent: runtime.isCustodyCurrent,
      createExecutor: admitted => fixture.createExecutor(admitted.credentials), signal: applyContext.signal,
    });
    if (!requester) throw new Error('Expected admitted requester Account projections');
    onTestFinished(requester.dispose);
    const result = await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] },
      context: { ...applyContext, externalActionExecutionAuthorization: requester.authorization } });
    expect(result).toMatchObject(joinFails ? { ok: false } : { operationId: expect.any(String) });
    expect(joined).toBe(!joinFails);
    const mutations = nativeCommands.filter(command => command.executable.endsWith('tailscale')
      && (command.args[0] === 'down' || command.args[0] === 'up'));
    expect(mutations.map(command => command.args[0])).toEqual(['down', 'up']);
    expect(mutations.at(-1)?.args).toContain('--force-reauth');
    expect(fileObservations).toEqual([{ path: keyFile, uid: 0, gid: 0, mode: 0o600, privateBytesMatch: true }]);
    expect(grantOperations[0]).toBe('set');
    expect(grantOperations).toContain('read');
    expect(grantOperations.at(-1)).toBe('remove');
    expect(stored).toBeUndefined();
    await expect(lstat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(materialReads).toBeGreaterThan(0);
    expect(JSON.stringify({ plan, result, commands: nativeCommands, launches: fixture.rootLaunches, plans: fixture.rootPlans }))
      .not.toContain(secretValue);
    logger.flushSync();
    const logs = await readFile(logger.getLogPath(), 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    expect(logs).not.toContain(secretValue);
  });
});
