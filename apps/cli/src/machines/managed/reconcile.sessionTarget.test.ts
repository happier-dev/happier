import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from '@/api/client/credentialAxios';
import { ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { fixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import type { ManagedMachineAcquisitionDriverInput } from './acquire';
import type { ManagedMachinePolicyInvalidation } from '@/api/apiMachine';
import { createManagedNativeInvocation, reconcileManagedMachine } from './reconcile';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient } from './acquire';
import { ensureAcceptedManagedWorkspaceTarget, registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { prepareWorkflowAcceptedWorkspaceTarget } from '@/daemon/workflows/resolveWorkflowWorkspace';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { deliverSessionTargetLaunch } from '@/daemon/spawn/prepareSessionTargetPlacement';
import { createManagedPresetHydrator } from './presetHydration';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { prepareManagedGuestCliBuildInput, resolveRemoteInstalledFirstPartyBinaryPath } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import nacl from 'tweetnacl';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionHttpBodyV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { reloadConfiguration } from '@/configuration';
import { createMachineProvisionerSpecializedPreparationAuthorFixture } from '../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createManagedMachinePresetPreparationBindingV1 } from '@happier-dev/cli-common/machines/managed';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PluginError } from '@happier-dev/cli-common/plugins/errors';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineControllerError } from './controllerErrors';

const trustBoundary = vi.hoisted(() => ({ stopScan: false }));
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
        if (trustBoundary.stopScan && args[0] === 'ssh-keyscan') throw new Error('Fixture stops at the SSH observation boundary');
        return actual.spawnSync(...args);
    } };
});

/**
 * A Session placed in a managed target: the already-admitted Session spawn is the
 * authority for that target's channel roles, through the one managed-invocation
 * owner (real custody check and contributed-Action dispatch; the plugin's role
 * handlers are the fixture's native boundary).
 */
const homeId = 'srv_session_target';
const machine = ManagedMachineV1Schema.parse({ id: 'managed-target', homeId, custodianAccountId: 'owner',
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Target', choices: {} },
    enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { guest: 'a' } },
    desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

const own = { guest: 'a' };

/** A fixture guest answering the holder bootstrap's commands (platform probe; holder files already present). */
function guestExec(input: unknown) {
    const { argv, inputBase64 } = input as { argv?: string[]; inputBase64?: string };
    const command = inputBase64 ? Buffer.from(inputBase64, 'base64').toString() : String(argv?.at(-1) ?? '');
    const stdout = command.includes('uname -s') ? 'Linux\naarch64\n/home/u\n'
        : command.includes('sha256sum') ? `${'a'.repeat(64)}  happier-session-holder\n${'b'.repeat(64)}  happier-process-custody\n` : '';
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
}

function harness(options: Readonly<{ streamRole?: boolean; holdStream?: boolean; guest?: boolean; targetExec?: (body: unknown) => Promise<ReturnType<typeof guestExec>>; targetPutFile?: (body: unknown) => Promise<void>;
    nativeOptions?: Parameters<typeof fixture>[0];
    onNativeRole?: NonNullable<Parameters<typeof fixture>[0]>['onNativeRole'] }> = {}) {
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const native = fixture({ ...options.nativeOptions, credentialPurposes: [], streamRole: options.streamRole ?? true,
        nativeCredentialService: Boolean(options.onNativeRole),
        ...(options.guest || options.targetExec ? { nativeRoleResults: { exec: (options.targetExec ?? guestExec) as never } } : {}),
        async onNativeRole(role, input, context) {
            calls.push(role); inputs.push(input);
            await options.onNativeRole?.(role, input, context);
            if (role === 'putFile') await options.targetPutFile?.(input);
            // A held channel runs until its invocation is aborted (the provider's carrier process).
            if (role === 'stream' && options.holdStream) await new Promise(resolve => context.signal?.addEventListener('abort', resolve, { once: true }));
        } });
    const refuse = async (): Promise<never> => { throw new Error('No credential use in this fixture'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: '.',
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: refuse, subscribe: () => ({ dispose() {} }) },
            selectTarget: refuse, resolveTarget: refuse, materializeAccount: refuse, projectTargetAccounts: refuse, assertTargetAccountMaterializable: refuse,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const input: ManagedMachineAcquisitionDriverInput = { token: 'controller-token', serverUrl: 'https://home.example', homeId,
        controller: machine.controller!, credentials: { token: 'controller-token', encryption: null }, managedProviderOperationAuthority: authority,
        runtimeRegistry: native.runtimeRegistry,
        homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection',
            descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example' }] } }),
    };
    return { calls, inputs, native, input };
}

async function installableGuestCliPayload() {
    const root = await mkdtemp(join(tmpdir(), 'bound-session-cli-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const guestHome = join(root, 'guest'), payload = join(root, 'payload');
    const binaryPath = resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', remoteHomeDir: join(guestHome, '.happier'),
        channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label });
    await Promise.all([mkdir(guestHome), mkdir(payload)]);
    await writeFile(join(payload, 'package.json'), JSON.stringify({ version: '0.3.0-dev' }));
    // The guest executable is an explicit operator fixture. Its self-install
    // delegates to the canonical installation owner, rather than simulating promotion.
    const installer = `import { installVersionedPayload } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@happier-dev/cli-common/firstPartyRuntime')).href)};
const args=process.argv.slice(1); const value=flag=>args[args.indexOf(flag)+1];
await installVersionedPayload({componentId:value('--component'),channel:value('--channel'),versionId:value('--version'),payloadRoot:value('--payload-root'),processEnv:process.env,selectAsDefaultReleaseChannel:true});`;
    await writeFile(join(payload, 'happier'), `#!/bin/sh
if [ "$1 $2" = 'self __install-payload' ]; then
  [ "$HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION" = '1' ] || exit 92
  exec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(createRequire(import.meta.url).resolve('tsx'))} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"
fi
if [ "$1" = '--version' ]; then printf '%s\n' '0.3.0-dev'; exit 0; fi
exit 91
`);
    await chmod(join(payload, 'happier'), 0o755);
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload);
    vi.stubGlobal('fetch', async () => Response.json({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } } }));
    onTestFinished(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    return { guestHome, binaryPath };
}

describe('Session-target authority for managed provider channel roles', () => {
    it.each(['manager', 'member', 'same-cli', 'default', 'configuration-changed', 'codec-only',
        'latest-configuration-changed', 'optin-removed', 'deferred-approval', 'latest-already-rebuilt',
        'cloud-same-cli', 'cloud-new-cli', 'cloud-stale', 'failed-image', 'absent-image', 'unknown-image', 'refused-image'] as const)(
      'selects prepared or cold launch through first acquisition (%s)', async scenario => {
        await withConfiguredDaemonTestHome({ prefix: 'first-use-preparation-' }, async () => {
            const cloud = scenario.startsWith('cloud-');
            const guest = { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } as const;
            const fixtureManifest = createMachineProvisionerSpecializedPreparationAuthorFixture().manifest;
            const manifest = normalizePluginManifestV2(cloud ? { ...fixtureManifest, contributes: {
                ...fixtureManifest.contributes, machineProvisioners: fixtureManifest.contributes.machineProvisioners.map(provisioner => ({
                    ...provisioner, preparation: { ...provisioner.preparation!, cliPayloadDelivery: 'guest-download' },
                })),
            } } : fixtureManifest);
            const provisioner = manifest.contributes.machineProvisioners[0]!;
            const provider = { pluginId: manifest.id, localId: provisioner.id };
            const launch = { provider, schemaVersion: 1, name: 'Admitted name', choices: { name: 'local' } };
            const artifact = (name: string) => ({ contributionRef: provider, schemaVersion: 1, value: { launch: { name } } });
            let inspectedArtifact = artifact('old-image');
            const nativeOperationRef = { contributionRef: provider, schemaVersion: 1, value: { claimId: 'native-image' } };
            const refusal = scenario === 'unknown-image' ? 'native_observation_unavailable'
                : scenario === 'refused-image' ? 'native_authorization_failed' : undefined;
            const acquired: unknown[] = [];
            const h = harness({ nativeOptions: { fixtureManifest: manifest, nativeRoleResults: {
                check: { available: true },
                options: { base: { launch: launch.choices, nativeFacts: { preparationGuest: guest } },
                    dimensions: { size: [], image: [], location: [], network: [], duration: [] } },
                preparationInspect: (): JsonValue => {
                    if (scenario === 'failed-image') return { kind: 'failed', code: 'snapshot_inactive', nativeOperationRef };
                    if (scenario === 'absent-image') return { kind: 'absent' };
                    if (scenario === 'unknown-image') return { kind: 'unknown', code: 'native_observation_unavailable', nativeOperationRef };
                    if (scenario === 'refused-image') throw new PluginError({ code: 'native_authorization_failed' });
                    return { kind: 'ready', artifact: inspectedArtifact };
                },
            } }, onNativeRole: async (role, body) => {
                if (role === 'acquire') { acquired.push(body); throw new Error('Fixture stops before guest allocation'); }
            } });
            let builtCliIdentity: string;
            if (cloud) {
                if (scenario === 'cloud-stale') {
                    await installableGuestCliPayload();
                    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA', JSON.stringify({
                        root: process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, identity: 'a'.repeat(64),
                    }));
                } else {
                    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', undefined);
                    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA', undefined);
                }
                let archiveDigest: string | undefined = 'b'.repeat(64);
                vi.stubGlobal('fetch', async () => Response.json({
                    homeConnectionDescriptor: { v: 1, revision: 1, homeServerIdentityId: homeId,
                        canonicalServerUrl: h.input.serverUrl, endpoints: [{ kind: 'https', url: h.input.serverUrl }] },
                    capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'stable',
                        ...(archiveDigest === undefined ? {} : {
                            payloads: [{ target: guest.target, sha256: archiveDigest, url: '/v1/runtime/guest-cli/payloads/linux/x64' }],
                        }) } },
                }));
                onTestFinished(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
                const build = await prepareManagedGuestCliBuildInput({ ...guest, homeUrl: h.input.serverUrl, guestDownload: { homeId } });
                builtCliIdentity = build.identity;
                if (scenario === 'cloud-new-cli') archiveDigest = 'c'.repeat(64);
                if (scenario === 'cloud-stale') archiveDigest = undefined;
            } else {
                await installableGuestCliPayload();
                const localPayloadRoot = process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT!;
                vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA', JSON.stringify({ root: localPayloadRoot, identity: 'a'.repeat(64) }));
                const currentCli = scenario === 'same-cli' || scenario.endsWith('-image');
                builtCliIdentity = `home-payload:${(currentCli ? 'a' : 'b').repeat(64)}`;
            }
            const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const row = ManagedOpaquePresetMachineV1Schema.parse({ id: 'first-use', homeId, custodianAccountId: 'owner',
                controller: machine.controller, preset: { id: 'first-use-preset', revision: 1, contentEncryptionMode: 'plain' },
                acquisitionMode: 'resource-bound', allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now',
                intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
            const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Admitted name', launch,
                preparation: { enabled: true, whenHappierUpdates: scenario === 'default' || scenario === 'cloud-new-cli'
                    ? 'update-at-start' : 'rebuild-automatically' },
                prepared: { operationId: 'original-build', status: 'ready', artifact: inspectedArtifact, cliBinaryPath: '/prepared/happier',
                    binding: createManagedMachinePresetPreparationBindingV1({ content: { launch: scenario === 'configuration-changed' || scenario === 'cloud-stale'
                        ? { ...launch, choices: { name: 'other-configuration' } } : launch }, credentialConfigurations: [],
                        cliIdentity: builtCliIdentity }) } }) };
            let current = row;
            let presetContent = scenario === 'latest-configuration-changed'
                ? { ...content, v: { ...content.v, launch: { ...launch, choices: { name: 'later-configuration' } } } }
                : scenario === 'optin-removed'
                    ? { ...content, v: { ...content.v, preparation: { enabled: true, whenHappierUpdates: 'update-at-start' as const } } }
                    : content;
            let presetRevision = 1;
            let prepareCalls = 0;
            let capabilityReads = 0;
            let presetReads = 0;
            let approvalReads = 0;
            let recordedApproval: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
            const progress: unknown[] = [];
            if (scenario === 'latest-already-rebuilt') {
                inspectedArtifact = artifact('new-image');
                presetContent = { ...content, v: { ...content.v, prepared: { ...content.v.prepared,
                    artifact: inspectedArtifact, binding: createManagedMachinePresetPreparationBindingV1({ content: { launch },
                        credentialConfigurations: [], cliIdentity: `home-payload:${'a'.repeat(64)}` }) } } };
            }
            const operations = createHostActionOperationRuntime({ machineId: machine.controller!.machineId,
                resolveAccountId: async () => 'owner', generateOperationId: () => 'new-image-operation' });
            const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                const path = new URL(String(url)).pathname;
                if (path.endsWith('/presets/get')) { presetReads++; return { status: 200, data: { kind: 'found', preset: {
                    id: row.preset.id, homeId, revision: presetRevision, controller: machine.controller, contentEncryptionMode: 'plain',
                    owner: scenario === 'member' ? { kind: 'team', teamId: 'team' } : { kind: 'account', accountId: 'owner' },
                    content: presetContent, recipients: [] } } }; }
                if (path.endsWith('/teams/get')) { capabilityReads++; return { status: 200, data: {
                    id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
                    policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                        defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null,
                        authenticationPolicyStatus: 'available' }, viewerRole: 'member',
                    capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, counts: null,
                    admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
                } }; }
                if (path.endsWith('/execution-authorization')) {
                    const request = body as { envelope: { v: 1; requestId: string; target: { kind: 'machine'; machineId: string }; input: unknown } };
                    return { status: 200, data: { v: 1, token: 'fresh-prepare-root', binding: { accountId: 'owner', custodianAccountId: 'owner',
                        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: homeId,
                        ...machine.controller, actionId: 'machines.presets.prepare', requestId: request.envelope.requestId,
                        target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                        presetPreparationAdmission: request.envelope.input } } };
                }
                if (path === '/v1/actions/machines.presets.prepare') {
                    prepareCalls++;
                    const request = body as { envelope: { requestId: string; input: unknown } };
                    const result = await operations.observeExecution({ actionId: 'machines.presets.prepare', input: request.envelope.input,
                        actionRequestId: request.envelope.requestId, execute: async operation => {
                            const accepted = { status: 'accepted' as const, operationId: operation.operationAcceptance!.operationId,
                                machineId: machine.controller!.machineId };
                            operation.operationAcceptance!.accept(accepted);
                            inspectedArtifact = artifact('new-image');
                            presetContent = { t: 'plain', v: ManagedMachinePresetContentV1Schema.parse({ ...content.v, name: 'Later rename',
                                prepared: { ...content.v.prepared, operationId: accepted.operationId, artifact: inspectedArtifact,
                                    binding: createManagedMachinePresetPreparationBindingV1({ content: { launch }, credentialConfigurations: [],
                                        cliIdentity: `home-payload:${'a'.repeat(64)}` }) } }) };
                            presetRevision++;
                            return { ok: true, result: accepted };
                        } });
                    if (scenario === 'deferred-approval') {
                        // Home's recorded Artifact is the persistence boundary. The real observer
                        // consumes the exact child origin and its recorded ordinary execution.
                        recordedApproval = StoredApprovalRequestSchema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
                            decision: { kind: 'approve', decidedAtMs: 2 },
                            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.presets.prepare',
                            actionArgs: request.envelope.input, summary: 'Build a prepared image; charges may apply.',
                            approval: { flow: 'deferred', result: 'required' },
                            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                                serverId: configuration.activeServerId, serverIdentityId: homeId, accountId: 'owner',
                                machineId: machine.controller!.machineId, actionId: 'machines.presets.prepare', requestId: request.envelope.requestId },
                            execution: { executedAtMs: 2, ok: true, result: result.ok ? result.result : null } });
                        return { status: 200, data: { v: 1, actionId: 'machines.presets.prepare', requestId: request.envelope.requestId,
                            execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'prepare-approval',
                                actionId: 'machines.presets.prepare' } } } };
                    }
                    return { status: 200, data: { v: 1, actionId: 'machines.presets.prepare', requestId: request.envelope.requestId, execution: result } };
                }
                if (path.endsWith('/submit')) { current = { ...current, allocation: 'may-exist' }; return { status: 200, data: { submitted: true, machine: current } }; }
                return { status: 200, data: { machine: current } };
            });
            const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'owner' }) };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 0 }) };
                if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 0 } };
                if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (path === '/v1/artifacts/prepare-approval' && recordedApproval) {
                    approvalReads++;
                    return { status: 200, data: { id: 'prepare-approval', ownerAccountId: 'owner', access: 'owner',
                        encryptionMode: 'plain', publicAudience: 'none',
                        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(recordedApproval)),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(recordedApproval) }),
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 } };
                }
                const publication = { id: machine.controller!.machineId, kind: 'persistent', active: true, revokedAt: null,
                    replacedByMachineId: null, installationId: machine.controller!.installationId, installationPublicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString('base64'),
                    storageMode: 'plain', access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
                return { status: 200, data: path === '/v1/machines' ? [publication] : { machine: publication } };
            });
            const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
                if (String(config.method).toUpperCase() === 'POST') return await axios.post(String(config.url), config.data, config);
                return await axios.get(String(config.url), config);
            });
            onTestFinished(() => { request.mockRestore(); post.mockRestore(); get.mockRestore(); });
            const channel = await createRequesterCurrentnessSocketHarness();
            onTestFinished(() => channel.close());
            const acquisition = { selection: { kind: 'preset' as const, homeId, id: row.preset.id, revision: 1 }, controller: machine.controller };
            const originalActionEnvelope = { v: 1 as const, requestId: 'first-use',
                target: { kind: 'machine' as const, machineId: machine.controller!.machineId }, input: acquisition };
            const source = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-acquire-root', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
                accountEncryptionMode: 'plain', serverIdentityId: homeId, ...machine.controller, actionId: 'machines.managed.acquire',
                requestId: 'first-use', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope),
                target: { kind: 'machine', machineId: machine.controller!.machineId } } });
            const requester = await admitRequesterAccountActionContext({ authorization: source, credentials,
                serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: h.input.serverUrl, isCurrent: async () => true });
            if (!requester) throw new Error('Expected admitted starter custody');
            onTestFinished(() => requester.dispose());
            const input = { ...h.input, token, credentials, externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey,
                waitForActionOperationCompletion: operations.runner.waitForCompletion,
                ...(scenario === 'deferred-approval' ? { observeRecordedApprovalExecution: createCliActionExecutorHarness({ token, credentials,
                    sessionId: '', mode: 'plain', ctx: null, serverId: configuration.activeServerId,
                    serverHttpBaseUrl: h.input.serverUrl }).observeRecordedApprovalExecution } : {}) };
            const hydrator = createManagedPresetHydrator(input);
            const opened = await hydrator.open(row, { content, recipients: [] });
            const executor = createActionExecutor({
                // The Account automation index is a network boundary; retain real admission with an empty Home index.
                actionAutomations: createActionAutomationPortV1({ accountId: 'owner',
                    seed: async () => ({ v: 1, rows: [] }), settle: async () => {} }),
                managedMachineAction: async ({ context }) => ManagedMachineControllerError.withActionFailure('machines.managed.acquire', async () => {
                    const options = { requestId: 'first-use', acquisitionMode: 'resource-bound' as const, context, signal: context.signal };
                    await reconcileManagedMachine({ input, options, hydrator, machine: opened, action: 'machines.managed.acquire',
                        client: createManagedMachineControllerClient(input, options, 'machines.managed.acquire', hydrator) });
                    return {};
                }) });
            const result = await executor.execute('machines.managed.acquire', acquisition, {
                surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'first-use',
                runtimeAccountId: 'owner', externalActionExecutionAuthorization: scenario === 'codec-only' ? source : requester.authorization,
                signal: new AbortController().signal,
                externalActionTarget: source.binding.target, originalActionEnvelope,
                actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.managed.acquire': ['cli'] } }),
                operationOwnerUpdate: { update(value) { progress.push(value.progress); } } });
            if (refusal) {
                expect(result).toMatchObject({ ok: false, errorCode: refusal });
                expect(acquired).toHaveLength(0);
                expect(prepareCalls).toBe(0);
                return;
            }
            expect(acquired, JSON.stringify(result)).toHaveLength(1);
            expect(prepareCalls).toBe(scenario === 'manager' || scenario === 'deferred-approval' ? 1 : 0);
            expect(capabilityReads).toBe(scenario === 'member' ? 1 : 0);
            expect(presetReads).toBe(scenario === 'manager' || scenario === 'deferred-approval' ? 2
                : scenario === 'member' || scenario === 'latest-configuration-changed' || scenario === 'optin-removed'
                    || scenario === 'latest-already-rebuilt' ? 1 : 0);
            expect(acquired).toMatchObject([{ managedId: row.id, launch: { name: scenario === 'manager'
                || scenario === 'deferred-approval' || scenario === 'latest-already-rebuilt' ? 'new-image'
                : scenario === 'configuration-changed' || scenario === 'cloud-stale'
                    || scenario === 'failed-image' || scenario === 'absent-image' ? 'local' : 'old-image' } }]);
            expect(approvalReads).toBe(scenario === 'deferred-approval' ? 1 : 0);
            if (scenario === 'deferred-approval') expect(progress).toContainEqual({ phase: 'waiting_for_approval',
                label: 'Waiting for approval', approval: { kind: 'approval_request_created', artifactId: 'prepare-approval',
                    actionId: 'machines.presets.prepare' } });
            expect(hydrator.readPresetDefinition(opened)?.name).toBe('Admitted name');
            expect(hydrator.readPresetDefinition(opened)?.preparationExecution?.updateCli).toBe(
                scenario === 'member' || scenario === 'default' || scenario === 'codec-only'
                    || scenario === 'latest-configuration-changed' || scenario === 'optin-removed'
                    || scenario === 'cloud-new-cli' ? true : undefined);
        });
    });
    it.each([false, true])('uses the author digest for a cold source without preparation guest metadata (Prepare %s)', async enabled => {
        const acquired: unknown[] = [];
        const h = harness({ onNativeRole: async (role, body) => {
            if (role === 'acquire') { acquired.push(body); throw new Error('Fixture stops before allocation'); }
        } });
        let row = ManagedOpaquePresetMachineV1Schema.parse({ id: machine.id, homeId, custodianAccountId: 'owner',
            controller: machine.controller, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            acquisitionMode: 'resource-bound', allocation: 'unsubmitted', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const digest = 'a'.repeat(64);
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Reviewed source',
            preparation: { enabled }, launch: machine.launch,
            authorEffectReview: { kind: 'devcontainer', reviewedEffectDigest: digest, effects: [] } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const input = { ...h.input, token, credentials: { token, encryption: null } };
        const hydrator = createManagedPresetHydrator(input);
        const opened = await hydrator.open(row, { content, recipients: [] });
        const options = { requestId: 'cold-source', acquisitionMode: 'resource-bound' as const,
            context: { operationOwnerUpdate: { update() {} } } };
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/submit')) {
                row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, allocation: 'may-exist' });
                return { status: 200, data: { submitted: true, machine: row } };
            }
            return { status: 200, data: { machine: row } };
        });
        onTestFinished(() => post.mockRestore());
        await expect(reconcileManagedMachine({ input, options, hydrator, machine: opened,
            action: 'machines.managed.acquire', client: createManagedMachineControllerClient(input, options, 'machines.managed.acquire', hydrator) })).rejects.toThrow();
        expect(acquired).toEqual([{ managedId: machine.id, launch: machine.launch!.choices, reviewedEffectDigest: digest }]);
    });

    it('admits transport preparation and channel roles for the Session\'s own target while the Session is current', async () => {
        const h = harness();
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        expect(await invocation.invoke('exec', { resource: own, argv: ['uname', '-m'] })).toEqual(roleResult('exec'));
        expect(await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' })).toEqual(roleResult('put-file'));
        expect(await invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).toEqual(roleResult('stream'));
        expect(await invocation.invoke('bootstrap', { resource: own })).toEqual(roleResult('bootstrap'));
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);

        // Least privilege: lifecycle and creation roles, and exec that would start a daemon, are refused before native IO.
        for (const role of ['power', 'destroy', 'acquire', 'rebuild', 'resize'] as const) {
            await expect(invocation.invoke(role, { resource: own })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        }
        await expect(invocation.invoke('exec', { resource: own, argv: ['true'], processConfig: { environment: { HOME: '/h', HAPPIER_HOME_DIR: '/h/.happier' },
            detachedDaemonStartArgv: ['happier', 'daemon', 'start'] } })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);

        // Bound to the Session's lifetime: once it ends, the authority is gone.
        session.abort();
        await expect(invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).rejects.toBeTruthy();
        expect(h.calls).toEqual(['exec', 'putFile', 'stream', 'bootstrap']);
    });

    it('is the only extra authority: without it the same call has no admission', () => {
        const h = harness();
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'no-authority' }, machine,
            action: 'session.spawn_new' } as never, () => machine)).toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('refuses a target controlled by another Machine', () => {
        const h = harness();
        const elsewhere = { ...machine, controller: { machineId: 'controller-2', installationId: 'installation-2' } };
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine: elsewhere,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => elsewhere))
            .toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('binds the authority to the row\'s own guest: another resource is refused before native IO', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        for (const [role, body] of [['exec', { resource: { guest: 'b' }, argv: ['true'] }], ['putFile', { resource: { guest: 'b' }, guestPath: '/h', bytesBase64: '' }],
            ['stream', { resource: { guest: 'b' }, argv: ['holder', 'attach'] }], ['stream', { argv: ['holder', 'attach'] }],
            ['bootstrap', { resource: { guest: 'b' } }]] as const) {
            await expect(invocation.invoke(role, body)).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });

    it('never wakes a stopped target: exec and putFile carry allowWake false', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        await invocation.invoke('exec', { resource: own, argv: ['true'] });
        await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' });
        expect(h.inputs).toEqual([expect.objectContaining({ allowWake: false }), expect.objectContaining({ allowWake: false })]);
    });

    it('ends a running channel when the Session ends', async () => {
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const channel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] });
        const settled = channel.then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        session.abort();
        await expect(settled).resolves.toBe('settled');
    });

    it('serves finite calls while the Session\'s Agent channel stays open (each call is its own provider operation)', async () => {
        // A placed Session holds its Agent's holder channel for its whole life; the Session-end cleanup, a second
        // Agent's holder start and the Files/Git channel all run next to it through the same authority.
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const agentChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        await expect(invocation.invoke('exec', { resource: own, argv: ['rm', '-rf', '/g/.happier/sessions/s1'] })).resolves.toEqual(roleResult('exec'));
        const filesChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach', '--ops'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream', 'exec', 'stream']);
        session.abort();
        await expect(Promise.all([agentChannel, filesChannel])).resolves.toEqual(['settled', 'settled']);
    });

    it('ends when the row stops being this Session\'s target (rebuilt, unbound or deleted)', async () => {
        const h = harness();
        let current = machine;
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => current);
        for (const changed of [{ ...machine, resource: { ...machine.resource!, value: { guest: 'rebuilt' } } },
            { ...machine, controller: { ...machine.controller!, installationId: 'installation-2' } },
            { ...machine, desired: 'delete' as const }]) {
            current = changed;
            await expect(invocation.invoke('exec', { resource: own, argv: ['true'] })).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });
});

describe('Session placement on a managed target (driver)', () => {
    const holder = { version: 'v1', resolveArtifacts: async () => ({ holder: { bytes: new Uint8Array([1]), sha256: 'a'.repeat(64) },
        helper: { bytes: new Uint8Array([2]), sha256: 'b'.repeat(64) } }) };

    it.each([
        { name: 'created container', created: true, identity: { kind: 'guestProcess', role: 'sandbox' }, sandbox: '1' },
        { name: 'created VM', created: true, identity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
            role: 'server', adminAccessAtCreation: 'none' }, sandbox: '1' },
        { name: 'personal native root Machine', created: false, identity: { kind: 'existingUser', role: 'personal' }, sandbox: undefined },
        { name: 'adopted root SSH host', created: false, identity: { kind: 'existingUser', role: 'adopted' }, sandbox: undefined },
        { name: 'guest without creation provenance', created: false, identity: { kind: 'guestProcess', role: 'sandbox' }, sandbox: undefined },
    ] as const)('marks only Happier-created targets sandboxed for Agent launches ($name)', async scenario => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true, enrollmentIdentity: scenario.identity,
            resource: { ...machine.resource, ...(scenario.created ? { origin: 'created' } : {}) } });
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const target = await driver.openSessionTarget({ managedId: row.id, sessionId: 'root-permission-policy',
            requesterAccountId: 'owner', lifetime: lifetime.signal, holder });
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'root-permission-policy',
            // A host assertion cannot turn an adopted target into a sandbox.
            runnerEnvironment: { IS_SANDBOX: '1' }, materializedRoot: null, requestAuthMaterializedRoot: null,
            agentCommand: null, agent: null, workspace: { hostRoot: '/host/workspace', targetRoot: '/workspace' },
            onSessionEnd() {} });
        expect(launch.env.IS_SANDBOX).toBe(scenario.sandbox);
    });

    const syncWorkspace = { v: 2 as const, kind: 'managed' as const, id: 'native-workspace', serverId: homeId,
        managedId: machine.id, controller: machine.controller!, rootPath: '/home/u/workspace', createdAtMs: 0 };

    it('refuses the other requester at Workflow admission before a guest bootstrap or file effect', async () => {
        const h = harness({ guest: true, holdStream: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true });
        const requesterIds: string[] = [];
        const driver = createManagedMachineAcquisitionDriver({
            ...h.input,
            readTargetCurrent: async (_id, target) => {
                requesterIds.push(target.requesterAccountId);
                return { machine: row, admitted: target.requesterAccountId === 'owner' };
            },
        });
        const pathIsDirectory = vi.fn(async () => true);
        const prepared = await prepareWorkflowAcceptedWorkspaceTarget({
            projectTarget: { machineId: syncWorkspace.controller.machineId, directory: syncWorkspace.rootPath,
                sessionPlacement: { kind: 'in_place', workspace: workspaceAddressFromRefV2(syncWorkspace) } },
            definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
            currentServerId: homeId, accountId: 'someone-else',
            resolveWorkspaceRef: () => syncWorkspace,
            restoreManagedWorkspaceSource: (workspace, signal) => ensureAcceptedManagedWorkspaceTarget({
                workspace, signal, requesterAccountId: 'someone-else',
                openTarget: request => driver.openProjectWorkspaceTarget({ ...request, holder }),
            }),
            pathIsDirectory,
        });
        expect(prepared).toEqual({ ok: false, code: 'workspace_unavailable' });
        expect(requesterIds).toEqual(['someone-else']);
        expect(h.calls).toEqual([]);
        expect(pathIsDirectory).not.toHaveBeenCalled();
    });

    it('admits a Project target under the Account custodian and revokes its channels on a managed-row push', async () => {
        const h = harness({ guest: true, holdStream: true });
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        let row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true });
        let reads = 0;
        let listener: Parameters<NonNullable<ManagedMachineAcquisitionDriverInput['subscribeManagedMachineChanges']>>[0] | undefined;
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async (_id, target) => { reads++; return { machine: row, admitted: target.requesterAccountId === 'owner' }; },
            subscribeManagedMachineChanges: next => { listener = next; return () => { listener = undefined; }; } });
        const request = { workspace: syncWorkspace, requesterAccountId: 'owner', lifetime: lifetime.signal, holder };
        await expect(driver.openProjectWorkspaceTarget({ ...request, workspace: { ...syncWorkspace,
            controller: { ...syncWorkspace.controller, installationId: 'other-installation' } } }))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(reads).toBe(0);
        await expect(driver.openProjectWorkspaceTarget({ ...request, requesterAccountId: 'someone-else' }))
            .rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
        expect(h.calls).toEqual([]);
        const target = await driver.openProjectWorkspaceTarget(request);
        const first = target.openChannel(['holder', 'workspace'], lifetime.signal);
        const closed = new Promise(resolve => first.once('close', resolve));
        first.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);
        expect(reads).toBe(2);
        await listener?.({ kind: 'managed', managedIds: ['unrelated'] });
        expect(reads).toBe(2);
        row = { ...row, desired: 'delete' };
        await listener?.({ kind: 'managed', managedIds: [row.id] });
        await closed;
        expect(reads).toBe(3);
        expect(target.lifetime.aborted).toBe(true);
        expect(h.calls.every(role => ['bootstrap', 'exec', 'putFile', 'stream'].includes(role))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('places requested holder artifacts through the admitted Sync target native port', async () => {
        const guestHome = await mkdtemp(join(tmpdir(), 'sync-target-holder-'));
        const lifetime = new AbortController();
        onTestFinished(async () => { lifetime.abort(); await rm(guestHome, { recursive: true, force: true }); });
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], {
                cwd: guestHome, env: { ...process.env, HOME: guestHome, PATH: '/usr/bin:/bin' },
            });
            child.child.stdin?.on('error', () => {});
            child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
            const result = await child.then(result => ({ ...result, status: 0 }), (error: unknown) => {
                if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number'
                    || !('stdout' in error) || typeof error.stdout !== 'string'
                    || !('stderr' in error) || typeof error.stderr !== 'string') throw error;
                return { status: error.code, stdout: error.stdout, stderr: error.stderr };
            });
            return { ...guestExec(body), termination: { observed: { kind: 'exit' as const, exitCode: result.status },
                requestedBy: { kind: 'none' as const } }, stdoutBase64: Buffer.from(result.stdout).toString('base64'),
                stderrBase64: Buffer.from(result.stderr).toString('base64') };
        }, targetPutFile: async body => {
            const request = body as { guestPath: string; bytesBase64: string };
            await writeFile(request.guestPath, Buffer.from(request.bytesBase64, 'base64'));
        } });
        const artifact = (contents: string) => ({ bytes: Buffer.from(contents), sha256: createHash('sha256').update(contents).digest('hex') });
        const artifacts = { holder: artifact('fixture native holder'), helper: artifact('fixture filesystem helper') };
        const row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const request = { managedId: row.id, relationshipId: 'account-sync', requesterAccountId: 'owner',
            workspace: { ...syncWorkspace, rootPath: join(guestHome, 'workspace') }, lifetime: lifetime.signal,
            holder: { version: 'sync-v1', resolveArtifacts: async () => artifacts } };
        const target = await driver.openWorkspaceSyncTarget(request);
        const holderPath = join(guestHome, '.happier', 'holder', 'sync-v1', 'happier-session-holder');
        const helperPath = join(guestHome, '.happier', 'holder', 'sync-v1', 'happier-process-custody');
        expect(target).toMatchObject({ holderPath, helperPath, home: guestHome });
        expect(await readFile(holderPath)).toEqual(artifacts.holder.bytes);
        expect(await readFile(helperPath)).toEqual(artifacts.helper.bytes);
        expect(h.calls).not.toContain('acquire');
    });

    it('keeps Account sync open after its creating Session ends, until the relationship ends', async () => {
        const h = harness({ guest: true, holdStream: true });
        const session = new AbortController(), relationship = new AbortController();
        onTestFinished(() => { session.abort(); relationship.abort(); });
        const row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true });
        let reads = 0;
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => { reads++; return { machine: row, admitted: true }; } });
        const sessionTarget = await driver.openSessionTarget({ managedId: row.id, sessionId: 'origin-session',
            requesterAccountId: 'owner', lifetime: session.signal, holder });
        const target = await driver.openWorkspaceSyncTarget({ managedId: row.id, relationshipId: 'account-sync',
            requesterAccountId: 'owner', workspace: syncWorkspace, lifetime: relationship.signal });
        const channel = target.openChannel(['happier', 'workspace', 'channel'], relationship.signal);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);
        session.abort();
        await expect(sessionTarget.exec('true', relationship.signal)).rejects.toMatchObject({ code: 'intent_changed' });
        await expect(target.exec('true', relationship.signal)).resolves.toMatchObject({ status: 0 });
        await expect(target.ensureWorkspaceRuntime()).resolves.toMatchObject({ binaryPath: expect.any(String) });
        expect(channel.destroyed).toBe(false);
        expect(reads).toBe(2); // One admission per lifetime, no reads per native effect.
        expect(h.calls.every(role => ['bootstrap', 'exec', 'stream'].includes(role))).toBe(true);
        expect(h.inputs.filter(body => typeof body === 'object' && body !== null && 'processConfig' in body)).toEqual([]);
        relationship.abort();
        await closed;
        await expect(target.exec('true', new AbortController().signal)).rejects.toMatchObject({ code: 'intent_changed' });
        expect(reads).toBe(2);
        // Reconnect uses the retained Account relationship, with no live Session or holder.
        const reconnect = new AbortController();
        onTestFinished(() => reconnect.abort());
        await expect(driver.openWorkspaceSyncTarget({ managedId: row.id, relationshipId: 'account-sync',
            requesterAccountId: 'owner', workspace: syncWorkspace, lifetime: reconnect.signal })).resolves.toMatchObject({ id: target.id });
    });

    it.each(['home', 'machine', 'installation', 'account', 'managed'] as const)('refuses a sync target outside the admitted %s scope before native IO', async mismatch => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine, admitted: mismatch !== 'account' }) });
        const workspace = { ...syncWorkspace,
            ...(mismatch === 'home' ? { serverId: 'other-home' } : {}),
            ...(mismatch === 'managed' ? { managedId: 'other-target' } : {}),
            controller: { ...syncWorkspace.controller,
                ...(mismatch === 'machine' ? { machineId: 'other-machine' } : {}),
                ...(mismatch === 'installation' ? { installationId: 'other-installation' } : {}) } };
        await expect(driver.openWorkspaceSyncTarget({ managedId: machine.id, relationshipId: 'account-sync',
            requesterAccountId: mismatch === 'account' ? 'other-account' : 'owner', workspace,
            lifetime: new AbortController().signal })).rejects.toMatchObject({
                code: mismatch === 'account' ? 'managed_target_access_unavailable' : 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('opens the existing guest CLI for native workspace operations without enrolling a Machine', async () => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, bootstrapInstalled: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const target = await driver.openSessionTarget({ managedId: row.id, sessionId: 'workspace-session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder });
        const opened = await target.ensureWorkspaceRuntime();
        expect(opened.binaryPath).toBe(resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli',
            remoteHomeDir: '/home/u/.happier', channel: resolveManagedCliReleaseChannelSync({
                argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label }));
        expect(row.enrolledMachineId).toBeUndefined();
    });

    it('publishes native SSH bootstrap trust on the original Session launch operation before network observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'session-bootstrap-trust-'));
        vi.stubEnv('HAPPIER_HOME_DIR', root); reloadConfiguration();
        onTestFinished(async () => { vi.unstubAllEnvs(); reloadConfiguration(); await rm(root, { recursive: true, force: true }); });
        trustBoundary.stopScan = true;
        onTestFinished(() => { trustBoundary.stopScan = false; });
        const updates: unknown[] = [];
        const h = harness({ onNativeRole: async (role, _input, context) => {
            if (role === 'bootstrap') await context.services.machineProvisioners.establishSshHostTrust({
                kind: 'ssh', address: '192.0.2.7', user: 'guest',
            });
        } });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine, admitted: true }) });
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 'session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update(value) { updates.push(value); } } },
        })).rejects.toBeTruthy();
        expect(updates).toContainEqual(expect.objectContaining({ domainRef: expect.objectContaining({
            kind: 'managedMachine', id: machine.id, bootstrapTask: expect.objectContaining({ taskKind: 'remote.ssh.bootstrapMachine.v1' }),
        }) }));
        expect(h.calls).toEqual(['bootstrap']);
    });

    it.each(['absent', 'empty', 'succeeded', 'skipped'] as const)('starts through the relay on a loopback-only Home without CLI installation when Setup is %s', async state => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            ...(state === 'absent' ? {} : { machineSetup: state === 'empty'
                ? { setup: { items: [], scripts: [{ body: '' }] }, state: 'pending' }
                : { setup: { scripts: [{ body: 'already-satisfied' }] }, state } }) });
        const fetch = vi.fn(async () => { throw new Error('Full CLI supplier must not be used'); });
        vi.stubGlobal('fetch', fetch);
        const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No installation report without installation'));
        onTestFinished(() => { vi.unstubAllGlobals(); post.mockRestore(); });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }),
            homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: {
                v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'http://controller.localhost:3033', revision: 1,
                endpoints: [{ kind: 'https', url: 'http://controller.localhost:3033' }],
            } }),
        });
        await expect(driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        })).resolves.toMatchObject({ id: `managed:${row.id}` });
        expect(fetch).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(row.bootstrapInstalled).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('replaces the bundled CLI for a selected warm image even without deferred Setup or enrollment', async () => {
        const { guestHome, binaryPath } = await installableGuestCliPayload();
        await mkdir(join(binaryPath, '..'), { recursive: true });
        await writeFile(binaryPath, '#!/bin/sh\n# old-prepared-cli\nprintf \'%s\\n\' \'0.3.0-alpha.1\'\n');
        await chmod(binaryPath, 0o755);
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            if (request.argv[2]!.includes('uname -s')) return { ...guestExec(body), stdoutBase64: Buffer.from(`Linux\naarch64\n${guestHome}\n`).toString('base64') };
            if (request.argv[2]!.includes('sha256sum')) return guestExec(body);
            const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], { cwd: guestHome, env: { ...process.env, HOME: guestHome } });
            child.child.stdin?.on('error', () => {});
            child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
            const result = await child;
            return { ...guestExec(body), stdoutBase64: Buffer.from(result.stdout).toString('base64') };
        }, targetPutFile: async body => {
            const request = body as { guestPath: string; bytesBase64: string };
            await writeFile(request.guestPath, Buffer.from(request.bytesBase64, 'base64'));
        } });
        const provisioner = h.native.manifest.contributes.machineProvisioners[0]!;
        let row = ManagedOpaquePresetMachineV1Schema.parse({ id: machine.id, homeId, custodianAccountId: 'owner',
            controller: machine.controller, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            acquisitionMode: 'resource-bound', bootstrapInstalled: true, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: machine.retention, wakeOnAcceptedMessage: false });
        const launch = machine.launch!;
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Prepared target', launch,
            preparationExecution: { launch, binaryPath, updateCli: true },
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: row.retention, wakeOnAcceptedMessage: false },
            nativeResult: { kind: 'bound', resource: machine.resource } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const reports: unknown[] = [];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
            if (String(url).endsWith('/context')) return { status: 200, data: { machine: row,
                presetContent: { content, recipients: [] }, requestId: 'creation' } };
            expect(String(url)).toBe('https://home.example/v1/machines/setup/report');
            const body = decodeExternalActionHttpBodyV1(wire)?.body ?? wire;
            reports.push(body);
            row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, bootstrapInstalled: true });
            return { status: 200, data: { machine: row } };
        });
        onTestFinished(() => post.mockRestore());
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, token, credentials: { token, encryption: null }, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const target = await driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session',
            requesterAccountId: 'owner', lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } });
        expect(target.id).toBe(`managed:${row.id}`);
        expect(await readFile(binaryPath, 'utf8')).toContain('self __install-payload');
        expect(await target.exec(`${safeBashSingleQuote(binaryPath)} --version`, new AbortController().signal)).toMatchObject({ status: 0, stdout: '0.3.0-dev\n' });
        // Reopening an already-placed Session does not repeat finite startup work.
        await driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder });
        expect(reports).toEqual([expect.objectContaining({ bootstrapInstalled: true,
            target: { kind: 'bound', controller: machine.controller, sessionId: 'committed-session' } })]);
        expect(row.machineSetup).toBeUndefined();
        expect(h.calls).not.toContain('acquire');
    }, 120_000);

    it.skipIf(process.platform === 'win32')('installs the Setup interpreter without enrollment, retains failed Setup and reuses installation on Retry', async () => {
        const { PassThrough } = await import('node:stream');
        const { runMachineSetupEffectInternal } = await import('../setup/effectInternal');
        const { MachineRecipeV1Schema } = await import('@happier-dev/protocol/machines/setup/machineRecipeV1');
        const recipe = MachineRecipeV1Schema.parse({ id: 'tool', revision: '1', title: 'Guest tool',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'tool', kind: 'command', executable: 'true', args: [],
                check: { executable: 'true', args: [], unsatisfiedExitCodes: [1] } }] });
        const { guestHome, binaryPath } = await installableGuestCliPayload();
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            if (request.argv[2]!.includes('uname -s')) return { ...guestExec(body), stdoutBase64: Buffer.from(`Linux\naarch64\n${guestHome}\n`).toString('base64') };
            if (request.argv[2]!.includes('sha256sum')) return guestExec(body);
            if (request.argv[2]!.includes('effect-internal')) {
                expect(await readFile(binaryPath, 'utf8')).toContain('self __install-payload');
                const stdin = new PassThrough(), stdout = new PassThrough();
                let text = '';
                stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
                stdin.end(Buffer.from(request.inputBase64!, 'base64'));
                // OS boundary: the interpreter executes in the guest's root
                // context; actual recipe resolution, Check and Apply stay real.
                const status = await runMachineSetupEffectInternal(['--operation-id=startup-operation'], { stdin, stdout, readUid: () => 0,
                    runNative: async command => {
                        const result = await promisify(execFile)(command.executable, command.args);
                        return { code: 0, stdout: result.stdout, stderr: result.stderr };
                    } });
                return { ...guestExec(body), stdoutBase64: Buffer.from(text).toString('base64'),
                    termination: { observed: { kind: 'exit', exitCode: status }, requestedBy: { kind: 'none' } } };
            }
            const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], { cwd: guestHome, env: { ...process.env, HOME: guestHome } });
            child.child.stdin?.on('error', () => {}); // Commands that never read stdin close it early; execFile still owns their exit result.
            child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
            try {
                const result = await child;
                return { ...guestExec(body), stdoutBase64: Buffer.from(result.stdout).toString('base64') };
            } catch (error) {
                if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
                return { ...guestExec(body), termination: { observed: { kind: 'exit', exitCode: error.code }, requestedBy: { kind: 'none' } } };
            }
        }, targetPutFile: async body => {
            const request = body as { guestPath: string; bytesBase64: string };
            await writeFile(request.guestPath, Buffer.from(request.bytesBase64, 'base64'));
        } });
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
        const target = { kind: 'machine' as const, machineId: machine.controller!.machineId };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-session-admission', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: homeId, actionId: 'session.spawn_new', requestId: 'creation', machineId: target.machineId,
            installationId: machine.controller!.installationId, target, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound', preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            machineSetup: { setup: { items: [{ kind: 'setupRecipe', selection: {
                ref: { pluginId: 'guest.tools', recipeId: recipe.id, revision: recipe.revision }, inputs: {} } }],
                scripts: [{ body: 'exit 19' }] }, state: 'pending' } });
        let reports = 0;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire, config) => {
            expect(url).toBe('https://home.example/v1/machines/setup/report');
            const body = decodeExternalActionHttpBodyV1(wire)?.body ?? wire;
            expect(body).toMatchObject({ homeId, managedId: retained.id, presetId: 'preset', presetRevision: 1,
                target: { kind: 'bound', controller: machine.controller, sessionId: 'committed-session' } });
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, target,
                installationId: machine.controller!.installationId, requestId: 'creation', effectActionId: 'session.spawn_new',
                method: 'POST', path: '/v1/machines/setup/report', body,
                signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
            if ('bootstrapInstalled' in body) {
                retained = ManagedMachineV1Schema.parse({ ...retained, bootstrapInstalled: true }); reports++;
            } else {
                const report = body as { state: 'running' | 'succeeded' | 'failed' };
                retained = ManagedMachineV1Schema.parse({ ...retained, machineSetup: { ...retained.machineSetup!, state: report.state } });
            }
            return { status: 200, data: { machine: retained } };
        });
        onTestFinished(() => post.mockRestore());
        const driver = createManagedMachineAcquisitionDriver({ ...h.input,
            runtimeRegistry: { ...h.input.runtimeRegistry, contributes: { ...h.input.runtimeRegistry.contributes,
                machineRecipes: [{ pluginId: 'guest.tools', definition: recipe }] } }, externalActionMachineRequestPrivateKey: keys.secretKey,
            readTargetCurrent: async () => ({ machine: retained, admitted: true }) });
        const operations = createHostActionOperationRuntime({ machineId: target.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'startup-operation' });
        const outcome = await operations.observeExecution({ actionId: 'session.spawn_new', input: {}, execute: async operation => {
            const request = { managedId: machine.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
                lifetime: new AbortController().signal, holder, operation: { ...operation, externalActionExecutionAuthorization: authorization, externalActionTarget: target } };
            await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
            expect(retained.bootstrapInstalled).toBe(true);
            expect(await readFile(binaryPath, 'utf8')).toContain('self __install-payload');
            const installedVersion = await realpath(binaryPath);
            await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
            const { operation: _, ...recovery } = request;
            await driver.openSessionTarget(recovery);
            expect(await realpath(binaryPath)).toBe(installedVersion);
            return { ok: true, result: {} };
        } });
        expect(outcome).toMatchObject({ ok: true });
        expect(reports).toBe(1);
        expect(h.calls).not.toContain('acquire');
    }, 120_000);

    it.skipIf(process.platform === 'win32')('runs bound scripts without installing an unused interpreter and retries only unfinished scripts on the same resource', async () => {
        const guestHome = await mkdtemp(join(tmpdir(), 'bound-script-retry-'));
        onTestFinished(() => rm(guestHome, { recursive: true, force: true }));
        const h = harness({ targetExec: async body => {
            const request = body as { argv: string[]; inputBase64?: string };
            if (request.argv[2]!.includes('uname -s')) return { ...guestExec(body), stdoutBase64: Buffer.from(`Linux\naarch64\n${guestHome}\n`).toString('base64') };
            if (request.argv[2]!.includes('sha256sum')) return guestExec(body);
            try {
                const child = promisify(execFile)('/bin/sh', ['-c', request.argv[2]!], { cwd: guestHome, env: { ...process.env, HOME: guestHome } });
                child.child.stdin?.on('error', () => {});
                child.child.stdin?.end(request.inputBase64 ? Buffer.from(request.inputBase64, 'base64') : '');
                const result = await child;
                return { ...guestExec(body), stdoutBase64: Buffer.from(result.stdout).toString('base64') };
            } catch (error) {
                if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
                return { ...guestExec(body), termination: { observed: { kind: 'exit', exitCode: error.code }, requestedBy: { kind: 'none' } } };
            }
        } });
        const provisioner = h.native.manifest.contributes.machineProvisioners[0]!;
        const { launch: _launch, resource: _resource, enrollmentIdentity: _identity, ...structuralMachine } = machine;
        let row = ManagedOpaquePresetMachineV1Schema.parse({ ...structuralMachine,
            acquisitionMode: 'resource-bound',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, machineSetup: { state: 'pending' } });
        const launch = machine.launch!;
        const setup = { scripts: [{ body: 'printf a >> "$HOME/effects"' },
            { body: '[ -f "$HOME/allow-b" ] || exit 19; printf b >> "$HOME/effects"' }] };
        let content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'script target', launch, setup,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: row.retention, wakeOnAcceptedMessage: false },
            nativeResult: { kind: 'bound', resource: machine.resource } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const states: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
            if (String(url).endsWith('/context')) return { status: 200, data: { machine: row,
                presetContent: { content, recipients: [] }, requestId: 'creation' } };
            expect(String(url)).toBe('https://home.example/v1/machines/setup/report');
            const body = (decodeExternalActionHttpBodyV1(wire)?.body ?? wire) as {
                state: 'running' | 'succeeded' | 'failed'; target: { sessionId: string }; presetContent: { content: typeof content };
            };
            expect(body.target.sessionId).toBe('committed-session');
            states.push(body.state);
            content = body.presetContent.content;
            row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, machineSetup: { state: body.state } });
            return { status: 200, data: { machine: row } };
        });
        const fetch = vi.fn(async () => { throw new Error('Scripts do not use the CLI interpreter'); });
        vi.stubGlobal('fetch', fetch);
        onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, token, credentials: { token, encryption: null }, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const request = { managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'setup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'machine_setup_setup_failed' });
        expect(await readFile(join(guestHome, 'effects'), 'utf8')).toBe('a');
        expect(content.v.setupSourceFacts).toMatchObject({ 'account:preset': { pendingScripts: [1] } });
        await writeFile(join(guestHome, 'allow-b'), '');
        await expect(driver.openSessionTarget(request)).resolves.toMatchObject({ id: `managed:${row.id}` });
        expect(await readFile(join(guestHome, 'effects'), 'utf8')).toBe('ab');
        expect(states).toEqual(['running', 'failed', 'running', 'succeeded']);
        expect(fetch).not.toHaveBeenCalled();
        expect(row.bootstrapInstalled).toBeUndefined();
        expect(h.calls).not.toContain('acquire');
    });

    it('refuses unfinished Setup before admitting an Agent target and preserves whole-success reuse', async () => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound', bootstrapInstalled: true,
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            machineSetup: { setup: { scripts: [{ body: 'required-setup-script' }] }, state: 'pending' } });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        const request = { managedId: row.id, sessionId: 'holder-nonce', committedSessionId: 'committed-session', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'startup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Network boundary unavailable'));
        onTestFinished(() => post.mockRestore());
        await expect(driver.openSessionTarget(request)).rejects.toMatchObject({ code: 'managed_controller_request_failed',
            details: { kind: 'managedControllerRequest', path: '/v1/machines/setup/report', category: 'transport' } });
        const prepared = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ admitted: true, machine: { ...row,
            machineSetup: { ...row.machineSetup!, state: 'succeeded' } } }) });
        await expect(prepared.openSessionTarget(request)).resolves.toMatchObject({ id: `managed:${row.id}` });
        const { operation: _, ...heldRecovery } = request;
        await expect(driver.openSessionTarget(heldRecovery)).resolves.toMatchObject({ id: `managed:${row.id}` });
    });

    it('requires the committed Session carrier before preparing a fresh bound target', async () => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, acquisitionMode: 'resource-bound' });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: true }) });
        await expect(driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder, operation: { actionRequestId: 'startup-operation',
                signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('cancels finite preparation with its Session operation before any guest effect', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine, admitted: true }) });
        const stopped = new AbortController();
        stopped.abort();
        const request = { managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'spawn-operation', signal: stopped.signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        await expect(driver.openSessionTarget(request)).rejects.toThrow();
        expect(h.calls).toEqual([]);
    });

    it('keeps live target authority after finite preparation ends and supports held recovery without another preparation operation', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine, admitted: true }) });
        const finished = new AbortController();
        const request = { managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder,
            operation: { actionRequestId: 'spawn-operation', signal: finished.signal,
                operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } };
        const target = await driver.openSessionTarget(request);
        finished.abort();
        await expect(target.exec('true', new AbortController().signal)).resolves.toMatchObject({ status: 0 });
        const { operation: _, ...recovery } = request;
        await expect(driver.openSessionTarget(recovery)).resolves.toMatchObject({ id: target.id });
    });

    it.each(['admitted', 'uncommitted', 'different-requester', 'unbound'] as const)(
      'places only the committed resource-bound creator Session across controller custody (%s)', async scenario => {
        const h = harness({ guest: true });
        const row = ManagedMachineV1Schema.parse({ ...machine, enrollmentAccountId: 'member',
            ...(scenario === 'unbound' ? {} : { acquisitionMode: 'resource-bound' }),
            preset: { id: 'team-preset', revision: 3, contentEncryptionMode: 'plain' } });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine: row, admitted: scenario === 'admitted' }) });
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        const opening = driver.openSessionTarget({ managedId: row.id, sessionId: 'holder-nonce',
            ...(scenario === 'uncommitted' ? {} : { committedSessionId: 'home-committed-session' }),
            requesterAccountId: scenario === 'different-requester' ? 'another-member' : 'member',
            lifetime: lifetime.signal, holder });
        if (scenario === 'admitted') {
            const target = await opening;
            await expect(target.exec('true', lifetime.signal)).resolves.toMatchObject({ status: 0 });
            expect(h.calls).toContain('bootstrap');
        } else {
            await expect(opening).rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
            expect(h.calls).toEqual([]);
        }
    });

    it('uses Home admission for an ordinary target before any native IO', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async (_id, target) => ({ machine, admitted: target.requesterAccountId === 'team-member' }) });
        const session = new AbortController();
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: session.signal, holder })).rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
        expect(h.calls).toEqual([]);
        // The admitted Team member uses the transport before the holder's platform probe.
        await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'team-member',
            lifetime: session.signal, holder }).catch(() => undefined);
        expect(h.calls.slice(0, 2)).toEqual(['bootstrap', 'exec']);
    });

    it('refuses a row this controller does not currently hold', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => null });
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('admits once across native effects, ignores unrelated pushes, and revokes a running channel on its selected row change', async () => {
        const h = harness({ holdStream: true, guest: true });
        const session = new AbortController();
        onTestFinished(() => { session.abort(); });
        let admitted = true;
        const row = { ...machine, enrolledMachineId: 'guest' };
        let reads = 0;
        let notify: ((change?: ManagedMachinePolicyInvalidation) => void | Promise<void>) | undefined;
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => { reads++; return { machine: row, admitted }; },
            subscribeManagedMachineChanges: listener => { notify = listener; return () => { notify = undefined; }; } });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: session.signal, holder });
        await target.exec('true', new AbortController().signal);
        await target.putFile('/g/config', new Uint8Array([1]), new AbortController().signal);
        const channel = target.openChannel(['holder', 'attach'], new AbortController().signal);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);
        expect(reads).toBe(1);
        await notify!({ kind: 'managed', managedIds: ['unrelated-target'] });
        await notify!({ kind: 'machines', machineIds: ['unrelated-machine'] });
        expect(reads).toBe(1);

        // Home withdraws access while custody stays the same. The push revokes the open channel.
        admitted = false;
        await notify!({ kind: 'machines', machineIds: ['guest'] });
        await closed;
        expect(reads).toBe(2);
        // ...and every later call is refused before native IO.
        const before = h.calls.length;
        await expect(target.exec('true', new AbortController().signal)).rejects.toMatchObject({ code: 'intent_changed' });
        expect(h.calls.length).toBe(before);
        expect(reads).toBe(2);
    });

    it('settles only the placed Session on confirmed native absence, after delete intent has revoked its channel', async () => {
        const h = harness({ holdStream: true, guest: true });
        const session = new AbortController();
        onTestFinished(() => session.abort());
        let row = machine;
        const survivor = { ...machine, id: 'surviving-target' };
        const survivingSession = new AbortController();
        onTestFinished(() => survivingSession.abort());
        let reads = 0;
        let unavailable = false;
        let settlementAvailable = false;
        const ended: string[] = [];
        const listeners = new Set<(change?: ManagedMachinePolicyInvalidation) => void | Promise<void>>();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async id => {
            reads++;
            if (unavailable) throw new Error('Home transport disconnected');
            return { machine: id === survivor.id ? survivor : row, admitted: true };
        }, subscribeManagedMachineChanges: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 'holder-nonce', committedSessionId: 'placed-session',
            requesterAccountId: 'owner', lifetime: session.signal, holder,
            onNativeAbsent: async () => {
                if (!settlementAvailable) throw new Error('Session Stop settlement unavailable');
                ended.push('placed-session');
                session.abort();
            } });
        const survivingTarget = await driver.openSessionTarget({ managedId: survivor.id, sessionId: 'surviving-holder',
            committedSessionId: 'surviving-session', requesterAccountId: 'owner', lifetime: survivingSession.signal, holder,
            onNativeAbsent: async () => { ended.push('surviving-session'); } });
        const notify = async (managedId = machine.id) => {
            await Promise.all([...listeners].map(listener => listener({ kind: 'managed', managedIds: [managedId] })));
        };
        const channel = target.openChannel(['holder', 'attach'], session.signal);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);
        expect(reads).toBe(2);
        await notify('unrelated-target');
        expect(reads).toBe(2);
        unavailable = true;
        await notify();
        expect(ended).toEqual([]);
        expect(target.lifetime.aborted).toBe(false);

        unavailable = false;
        row = { ...machine, desired: 'delete', intentRevision: machine.intentRevision + 1 };
        await notify();
        await closed;
        expect(target.lifetime.aborted).toBe(true);
        expect(ended).toEqual([]);
        expect(session.signal.aborted).toBe(false);

        // The allocation fact arrives later than admission revocation. A different guest's push is irrelevant.
        row = { ...row, allocation: 'confirmed-absent', resource: undefined,
            observation: { observedAt: 123, availability: 'absent' } };
        const beforeUnrelated = reads;
        await notify('unrelated-target');
        expect(reads).toBe(beforeUnrelated);
        await expect(notify()).rejects.toThrow('Session Stop settlement unavailable');
        expect(ended).toEqual([]);
        expect(listeners.size).toBe(2);
        // A reconnect's existing owner notification may complete a failed Stop; no local retry is scheduled.
        settlementAvailable = true;
        await notify();
        expect(ended).toEqual(['placed-session']);
        const settledReads = reads;
        await notify();
        expect(ended).toEqual(['placed-session']);
        expect(reads).toBe(settledReads);
        expect(survivingTarget.lifetime.aborted).toBe(false);
        await expect(survivingTarget.exec('true', survivingSession.signal)).resolves.toMatchObject({ status: 0 });
        expect(listeners.size).toBe(1);
        survivingSession.abort();
        expect(listeners.size).toBe(0);
    });

    it('routes an unscoped workspace request to the live Session after deletion revokes the earlier target at the same root', async () => {
        const h = harness({ guest: true });
        const replacement = { ...machine, id: 'replacement-target' };
        const rows = new Map([[machine.id, machine], [replacement.id, replacement]]);
        const listeners = new Set<(change?: ManagedMachinePolicyInvalidation) => void | Promise<void>>();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async id => {
            const row = rows.get(id);
            return row ? { machine: row, admitted: true } : null;
        },
            subscribeManagedMachineChanges: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
        const root = await mkdtemp(join(tmpdir(), 'placed-workspace-source-'));
        onTestFinished(() => rm(root, { recursive: true, force: true }));
        const place = async (managedId: string, sessionId: string) => {
            const session = new AbortController();
            onTestFinished(() => session.abort());
            const target = await driver.openSessionTarget({ managedId, sessionId, requesterAccountId: 'owner',
                lifetime: session.signal, holder });
            registerSessionTargetWorkspace({ sessionId, lifetime: session.signal, primarySocketPath: join(target.socketDirectory, `${sessionId}.sock`),
                target: { ...target, exec: command => target.exec(command, session.signal),
                    openChannel: argv => target.openChannel(argv, session.signal) },
                workspace: { hostRoot: root, targetRoot: '/g/project' } });
            return { session, target };
        };
        const old = await place(machine.id, 'old-session');
        const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
        const selectByDirectory = () => admission.selectWorkspaceSource(undefined, { cwd: root });
        const oldSource = selectByDirectory();
        expect(oldSource.id).toBe('managed:managed-target:old-session');

        rows.set(machine.id, { ...machine, desired: 'delete', intentRevision: machine.intentRevision + 1 });
        await Promise.all([...listeners].map(async listener => await listener({ kind: 'managed', managedIds: [machine.id] })));
        expect(old.session.signal.aborted).toBe(false);
        await expect(old.target.exec('true', old.session.signal)).rejects.toMatchObject({ code: 'intent_changed' });
        expect(selectByDirectory()).toBe(oldSource); // A revoked-only root must still refuse through the target.
        const live = await place(replacement.id, 'live-session');
        await expect(live.target.exec('true', live.session.signal)).resolves.toMatchObject({ status: 0 });
        const liveScope = { authorization: { kind: 'session.write', sessionId: 'live-session' } };
        const liveSource = admission.selectWorkspaceSource(liveScope, { cwd: root });
        expect(liveSource.id).toBe('managed:replacement-target:live-session');
        expect(selectByDirectory()).toBe(liveSource);
        expect(admission.selectWorkspaceSource({ authorization: { kind: 'session.write', sessionId: 'old-session' } }, { cwd: root })).toBe(oldSource);
    });

    it.each([false, true, 'baked', 'deferred', 'project'] as const)('opens an admitted opaque target and preserves required Session Setup (%s)', async requiredSetup => {
        const h = harness({ guest: true });
        const provisioner = h.native.manifest.contributes.machineProvisioners[0]!;
        const launch = machine.launch!;
        let row = ManagedOpaquePresetMachineV1Schema.parse({ id: machine.id, homeId, custodianAccountId: 'owner',
            controller: machine.controller, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
            acquisitionMode: 'resource-bound', ...(requiredSetup === 'deferred' ? {} : { bootstrapInstalled: true }),
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        let content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'private-target', launch,
            ...(requiredSetup && requiredSetup !== 'project' ? { setup: { scripts: [{ body: 'required-setup-script' }] } } : {}),
            ...(requiredSetup === 'baked' || requiredSetup === 'deferred' ? { preparationExecution: { launch, binaryPath: '/prepared/happier',
                ...(requiredSetup === 'deferred' ? { deferredSetup: { scripts: [{ body: 'required-setup-script' }] } } : {}) } } : {}),
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: row.retention, wakeOnAcceptedMessage: false },
            nativeResult: { kind: 'bound', resource: machine.resource } }) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
        const admittedTarget = { kind: 'machine' as const, machineId: machine.controller!.machineId };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'session-context-admission', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: homeId, actionId: 'session.spawn_new', requestId: 'creation', machineId: admittedTarget.machineId,
            installationId: machine.controller!.installationId, target: admittedTarget, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        let contexts = 0;
        let contextRequest: { body: unknown; signature: string } | undefined;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, wire, config) => {
            if (String(url).endsWith('/machines/setup/report')) {
                const report = (decodeExternalActionHttpBodyV1(wire)?.body ?? wire) as {
                    state: 'running' | 'succeeded' | 'failed'; presetContent: { content: typeof content };
                };
                content = report.presetContent.content;
                row = ManagedOpaquePresetMachineV1Schema.parse({ ...row, machineSetup: { state: report.state } });
                return { status: 200, data: { machine: row } };
            }
            expect(String(url)).toBe('https://home.example/v1/machines/managed/controller/context');
            // The scoped Project target admission is the only authority the
            // daemon has here. Its ambient token cannot open a bound context.
            if (requiredSetup === 'project') return { status: 403, data: { code: 'permission_denied' } };
            const body = decodeExternalActionHttpBodyV1(wire)?.body ?? wire;
            contextRequest = { body, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) };
            contexts++;
            return { status: 200, data: { machine: row, presetContent: { content, recipients: [] }, requestId: 'creation' } };
        });
        try {
            const driver = createManagedMachineAcquisitionDriver({ ...h.input, token, credentials: { token, encryption: null },
                externalActionMachineRequestPrivateKey: keys.secretKey,
                readTargetCurrent: async (_id, target) => ({
                    machine: row, admitted: true, ...('includePresetContent' in target && target.includePresetContent === true
                        ? { presetContent: { content, recipients: [] } } : {}),
                }) });
            if (requiredSetup === 'project') {
                const lifetime = new AbortController();
                onTestFinished(() => { lifetime.abort(); });
                const target = await driver.openProjectWorkspaceTarget({
                    workspace: { serverId: homeId, managedId: row.id, controller: machine.controller!, rootPath: '/g/project' },
                    requesterAccountId: 'owner', lifetime: lifetime.signal, holder,
                });
                await expect(target.exec('true', lifetime.signal)).resolves.toMatchObject({ status: 0 });
                expect(post).not.toHaveBeenCalled();
                return;
            }
            const opening = driver.openSessionTarget({ managedId: row.id, sessionId: 's1', committedSessionId: 'committed-session', requesterAccountId: 'owner',
                lifetime: new AbortController().signal, holder,
                operation: { actionRequestId: 'startup-operation', signal: new AbortController().signal,
                    externalActionExecutionAuthorization: authorization, externalActionTarget: admittedTarget,
                    operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } } }).then(target => {
                expect(contextRequest?.body).toMatchObject({ managedId: row.id, sessionId: 'committed-session' });
                expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, target: admittedTarget,
                    installationId: machine.controller!.installationId, requestId: 'creation', effectActionId: 'session.spawn_new',
                    method: 'POST', path: '/v1/machines/managed/controller/context', body: contextRequest?.body,
                    signature: contextRequest?.signature ?? '', publicKey: keys.publicKey })).toBe(true);
                return target;
            });
            if (requiredSetup === true || requiredSetup === 'deferred') {
                await expect(opening).resolves.toMatchObject({ id: `managed:${row.id}` });
                expect(row).toHaveProperty('machineSetup.state', 'succeeded');
                if (requiredSetup === 'deferred') {
                    expect(row.bootstrapInstalled).not.toBe(true);
                    expect(h.calls).not.toContain('putFile');
                    expect(h.inputs.some(input => {
                        const payload = input as { inputBase64?: string };
                        return payload.inputBase64 && Buffer.from(payload.inputBase64, 'base64').toString('utf8').includes('required-setup-script');
                    })).toBe(true);
                }
                return;
            }
            const target = await opening;
            expect(target.platform.os).toBe('linux');
            expect(h.calls).toContain('exec');
            await target.exec('true', new AbortController().signal);
            await target.putFile('/g/config', new Uint8Array([1]), new AbortController().signal);
            expect(contexts).toBe(1);
            expect(row).not.toHaveProperty('launch');
            expect(row).not.toHaveProperty('resource');
        } finally { post.mockRestore(); }
    });

    it('sends target commands as the provider exec input, never in its argv (host and guest process lists)', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readTargetCurrent: async () => ({ machine, admitted: true }) });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder });
        await target.exec("printf '%s' fixture-agent-arg", new AbortController().signal);
        const last = h.inputs.at(-1) as { argv: string[]; inputBase64?: string };
        expect(JSON.stringify(last.argv)).not.toContain('fixture-agent-arg');
        expect(Buffer.from(last.inputBase64 ?? '', 'base64').toString()).toContain('fixture-agent-arg');
    });
});
