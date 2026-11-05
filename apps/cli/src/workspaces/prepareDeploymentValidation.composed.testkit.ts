import axios from 'axios';
import type nacl from 'tweetnacl';
import { delimiter, join } from 'node:path';
import { onTestFinished, expect, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { EnvironmentSecretLaunchAdmissionResultV1Schema } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import type { ServerProfile } from '@/server/serverProfiles';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentTargetHostInput, type OwnServerDeploymentRequest } from '@/deployments/targets/ownServer/ownServerDeploymentTarget';
import { buildOwnServerDeploymentReceipt } from '@/deployments/targets/ownServer/buildReceipt';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createCliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { configuration } from '@/configuration';
import * as installationStore from '@/daemon/identity/store';
import { createScmContractTempDirectory } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';

export async function validatePreparedDeploymentHead(input: Readonly<{
    sha: string;
    runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    installation: ReturnType<typeof nacl.sign.keyPair>;
    credentials: StoredCredentials;
    serverId: string;
    machineId: string;
    accountId: string;
    workspace: Readonly<{ source: Readonly<{ sourceId: string; revision: number }> }>;
}>) {
    const { sha, runtime, installation, credentials, serverId, machineId, accountId, workspace } = input;
    const token = credentials.token;
    const validationRoot = createScmContractTempDirectory('happier-prepare-validation-');
    const docker = await createOwnServerDockerBoundary(join(validationRoot, 'docker'));
    await docker.registerBuildResult('app', sha);
    // Saved settings are an OS boundary; native profile/identity resolution stays real.
    const settings = await persistence.readSettings();
    const profile: ServerProfile = { id: serverId, name: 'Prepare validation Home',
      serverUrl: 'https://prepare-pr-home.test', webappUrl: 'https://prepare-pr-home.test',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_prepare_pr_home',
        canonicalServerUrl: 'https://prepare-pr-home.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://prepare-pr-home.test' }] }) };
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { ...settings.servers, [serverId]: profile } });
    const previousHome = configuration.happyHomeDir;
    const incumbentServices = new Set(runtime.registry.projectManagedServices.listProjectServices());
    const lifetime = new AbortController();
    Reflect.set(configuration, 'happyHomeDir', validationRoot);
    vi.stubEnv('PATH', `${join(validationRoot, 'docker')}${delimiter}${process.env.PATH ?? ''}`);
    onTestFinished(async () => {
      lifetime.abort();
      try {
        for (const handle of runtime.registry.projectManagedServices.listProjectServices()) {
          if (!incumbentServices.has(handle)) await handle.dispose();
        }
      } finally {
        Reflect.set(configuration, 'happyHomeDir', previousHome);
        vi.unstubAllEnvs();
        await removeTempDir(validationRoot);
      }
    });
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'prepare-pr-installation', createdAt: 1,
      publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(installation.secretKey).toString('base64url') });
    const environment = createDeploymentEnvironmentDetailV1();
    Object.assign(environment.environment, { serverId, projectSourceId: workspace.source.sourceId,
      createdByAccountId: accountId, owner: { kind: 'account', accountId },
      controllerMachineId: machineId, buildMachineId: machineId });
    Object.assign(environment.targetLinks[0].targetLink, { machines: [machineId],
      members: [{ machineId, installationId: 'prepare-pr-installation', state: 'active' }] });
    delete environment.targetLinks[0].targetLink.activeDeploymentId;
    environment.content.bindings = [];
    environment.content.definition = { kind: 'repository', ref: 'prepare/deployment',
      compose: { path: 'compose.yaml', profiles: [], services: ['app'], primaryService: 'app' } };
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment,
      state: 'queued', requestedByAccountId: accountId, startedAtMs: undefined, settledAtMs: undefined,
      acceptedExecution: { v: 1, controller: { machineId, installationId: 'prepare-pr-installation' },
        builder: { machineId, installationId: 'prepare-pr-installation' } } });
    receipt.content.sourceIntent = { kind: 'repository', projectSourceId: workspace.source.sourceId,
      sourceRevision: workspace.source.revision, sha, compose: environment.content.definition.compose };
    receipt.content.machines = [machineId]; receipt.content.buildMachineId = machineId;
    receipt.content.images = []; receipt.content.machineResults = []; receipt.content.steps = [];
    const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => serverId,
      resolveHostIdentity: async () => ({ machineId, installationId: 'prepare-pr-installation', custodianAccountId: accountId }) });
    const machineAdmission = { actorAccountId: accountId, custodianAccountId: accountId, machineId,
      installationId: 'prepare-pr-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
      input: { serverId, environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        targetLinkId: receipt.deployment.targetLinkId, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
        requestKey: receipt.deployment.requestKey, contentArtifactId: receipt.deployment.contentArtifactId,
        contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
      receipt: { ok: true, environmentId: receipt.deployment.environmentId, revision: environment.environment.revision,
        deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
      context: { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId, signal: lifetime.signal,
        machineAdmission, verifyMachineAdmissionCurrent: async () => true,
        operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
    let secretAdmissions = 0;
    let deploymentRequests = 0;
    let buildResult: unknown;
    const previousRequest = vi.mocked(axios.request).getMockImplementation()!;
    vi.mocked(axios.request).mockImplementation(async config => {
      const path = new URL(String(config.url)).pathname;
      if (path.endsWith('/secret-launch-admission')) {
        secretAdmissions++;
        expect(config.method?.toUpperCase()).toBe('POST');
        expect(config.data).toMatchObject({ serverId, environmentId: environment.environment.id,
          machineId, installationId: 'prepare-pr-installation', proof: expect.any(Object) });
        return { status: 200, data: EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true, grants: [] }) };
      }
      if (path === '/v1/deployments/environments/' + environment.environment.id) {
        expect(config.method?.toUpperCase()).toBe('GET');
        return { status: 200, data: { ok: true, environment: structuredClone(environment.environment),
          targetLinks: environment.targetLinks.map(({ targetLink }) => structuredClone(targetLink)) } };
      }
      if (path.startsWith('/v1/deployments/') && config.method?.toUpperCase() === 'POST') {
        deploymentRequests++;
        expect(environment.environment.protection).toBe('nonProduction');
        expect(config.data).toMatchObject({ environmentId: environment.environment.id,
          actionOperationId: receipt.deployment.actionOperationId });
        return { status: 200, data: request.receipt };
      }
      return previousRequest(config);
    });
    const host: OwnServerDeploymentTargetHostInput = { credentials, serverId, serverHttpBaseUrl: 'https://prepare-pr-home.test', machineId,
      signal: lifetime.signal,
      async readEnvironment() { return structuredClone(environment); },
      async readReceipt() { return structuredClone(receipt); },
      async *readBuildHistory() { yield structuredClone(receipt); },
      async writeTransition(input) {
        expect(input.expectedRevision).toBe(receipt.deployment.revision);
        receipt.content = structuredClone(input.content);
        receipt.deployment = { ...receipt.deployment, state: input.state, revision: receipt.deployment.revision + 1 };
        if (input.state === 'succeeded') environment.targetLinks[0].targetLink.activeDeploymentId = receipt.deployment.id;
        return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
          deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
      },
      // In-process Machine transport enters the same receiving owner; no
      // substitute review basis or build result is supplied by the fixture.
      reviewMember: input => target.reviewMember(input),
      async dispatchBuild(request) { const built = await buildOwnServerDeploymentReceipt(host, request); buildResult = built; return built; },
      runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId, serverHttpBaseUrl: 'https://prepare-pr-home.test', machineId,
        resolveRequesterIdentity: async context => {
          const requester = await identityOwner.resolveActionRequester!(context);
          try { return requester.identity; } finally { await requester.dispose(); }
        },
        signal: lifetime.signal, async acquirePluginRuntimeRegistryLease() { return runtime.controller.tryAcquireRuntimeRegistry()!; } }),
    };
    const target = createOwnServerDeploymentTargetForHost(host);
    const review = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content,
      context: { ...request.context, operationAcceptance: undefined } });
    expect(review.inputBasis.sourceIntent).toMatchObject({ kind: 'repository', sha });
    expect(deploymentRequests).toBe(0);
    expect((await docker.readInvocations()).some(call => call.args.includes('up')
      || call.args[0] === 'buildx' && call.args[1] === 'bake' && !call.args.includes('--print'))).toBe(false);
    receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
    const accountAdmission = createCliProjectAdmission({ serverId, credentials, serverHttpBaseUrl: 'https://prepare-pr-home.test' }, {
      projectHomeId: serverId, actionHomeId: serverId,
      executionRunActionFailure: (code, error = code, details) => ({ ok: false, errorCode: code, error,
        ...(details === undefined ? {} : { details }) }),
    });
    const deploy = createActionExecutor(createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://prepare-pr-home.test',
      admitAccount: accountAdmission.projectAccountAdmission,
      resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }),
      dispatchReceipt: dispatched => target.execute(dispatched),
    }));
    const result = await deploy.execute('deployments.deploy', request.input, request.context);
    expect(result, JSON.stringify({ result, buildResult, receipt, docker: await docker.readInvocations() })).toMatchObject({ ok: true,
      result: { ok: true, state: 'succeeded', deploymentId: receipt.deployment.id } });
    expect(deploymentRequests).toBe(1);
    expect(secretAdmissions).toBeGreaterThan(0);
    expect(receipt.content.sourceIntent).toMatchObject({ sha });
    expect(receipt.content.machineResults).toEqual([expect.objectContaining({ machineId,
      currentDeploymentId: receipt.deployment.id, activation: 'succeeded', health: 'healthy' })]);
    expect(receipt.content.images).toHaveLength(1);
    expect(receipt.content.ownServer?.imageArchives).toHaveLength(1);
    expect((await docker.readInvocations()).some(call => call.args[0] === 'buildx' && call.args[1] === 'bake' && !call.args.includes('--print'))).toBe(true);
    return `Validation succeeded: deployments.deploy nonProduction Environment ${environment.environment.id}; operation ${receipt.deployment.actionOperationId}; receipt ${receipt.deployment.id}; build succeeded; health healthy; exact head ${sha}.`;
}
