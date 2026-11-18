import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { bindCallerInput } from '@happier-dev/protocol/actions/executor/callerInput';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHash } from 'node:crypto';
import { projectExternalActionHttpError, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const disclosureConsent = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: disclosureConsent } }).module;
});
// Only authenticated HTTP and device credential IO leave this process.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { executeOriginalAccountActionTransport, executeOriginalAccountMachineAction, readOriginalAccountActionMachine } = await import('./externalActionAccountTransport');
const { machinePluginUiResourceRead, machinePluginStructuredMessageActionExecute } = await import('@/sync/ops/machineContributionRegistryProjection');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
const path = '/v1/actions/plugins.uninstall';
const binding: ExternalActionEncryptionBindingV2 = {
    serverIdentityId: 'srv_plugin_transport', accountId: 'owner',
    authentication: { kind: 'account', tokenEpoch: 0 },
    actionId: 'plugins.uninstall', requestId: 'uninstall-1', target: { kind: 'machine', machineId: 'machine-1' },
};

beforeEach(async () => {
    await homes.reset();
    disclosureConsent.mockReset().mockResolvedValue(true);
    serverId = await homes.addHome({ name: 'Plugin transport', serverUrl: 'https://plugin-transport.test',
        serverIdentityId: binding.serverIdentityId, accountId: 'owner', currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; vi.useRealTimers(); await homes.reset(); });

function answerOwnedMachine() {
    const machine = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: 'owner' }), installationId: 'installation-1' };
    homes.answer(serverId, '/v1/machines/machine-1', { body: { machine } });
}

async function execute() {
    if (!account) throw new Error('Expected captured Account');
    const result = await executeOriginalAccountActionTransport({ account, binding,
        input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' });
    expect(homes.requestsFor(path)).toHaveLength(1);
    expect(ActionExecuteFailureSchema.safeParse(result).success).toBe(true);
    return result;
}

describe('captured Account Action response decoding', () => {
    it.each([
        { captureDefaults: true, observeCommit: false },
        { captureDefaults: true, observeCommit: true },
        { captureDefaults: false, observeCommit: true },
    ])('transports the signed UI Session caller without a review marker (defaults=$captureDefaults, observation=$observeCommit)', async ({ captureDefaults, observeCommit }) => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const input = projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
            creationKey: 'ordinary-ui-capture', executionTarget: { serverId: binding.serverIdentityId, machineId: 'machine-1' },
            directory: { kind: 'path', path: '/project' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            ...(observeCommit ? { observeSessionCommit: true } : {}),
        }));
        const sessionCreationDefaults = { context: buildManagedSessionDefaultsContext({
            personalDefaultsRow: { defaultAgentTarget: input.agentTarget },
        }), authoredChoices: { executionTarget: input.executionTarget, agentTarget: input.agentTarget } };
        let receivedCapture: unknown;
        let receivedInput: unknown;
        homes.answer(serverId, 'POST /v1/home/governance/get', { body: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) });
        homes.answer(serverId, 'GET /v1/machines/machine-1/access', { body: {
            machineId: 'machine-1', custodian: { accountId: 'owner', displayName: 'Owner' },
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine-1',
            tokenEpoch: 0, actionId: 'session.spawn_new', execute: (received, context) => {
                receivedInput = received;
                receivedCapture = context.invocation.sessionCreationDefaults;
                return projectSessionSpawnNewActionResultV1({ type: 'success', disposition: 'created', sessionId: 'created-session',
                    executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'notRequested' } });
            }, failure: value => {
                const parsed = ActionExecuteFailureSchema.safeParse(value);
                return parsed.success ? parsed.data : null;
            },
        });
        const result = await createDefaultActionExecutor().execute('session.spawn_new', input, {
            surface: 'ui', authority: 'present_user', ...(captureDefaults ? { sessionCreationDefaults } : {}),
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { sessionId: 'created-session' } });
        if (captureDefaults) expect(receivedCapture).toEqual(sessionCreationDefaults);
        else expect(receivedCapture).toMatchObject({ authoredChoices: {
            executionTarget: input.executionTarget, agentTarget: input.agentTarget,
        } });
        expect(receivedInput).toMatchObject(input);
    });
    it.each(['voice', 'api'] as const)('keeps the sealed %s Session caller terminal despite an observation preference', async surface => {
        account?.dispose();
        // R135's payload after the existing catalog binder selected Codex.
        const input = {
            executionTarget: { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', machineId: 'ea391815-b2f8-4485-903c-145019cbe76d' },
            directory: { kind: 'path', path: '.' },
            initialInput: { text: 'Create a file named teal containing the text blue.' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            observeSessionCommit: true,
        };
        const serverUrl = 'https://r135-spawn.test';
        serverId = await homes.addHome({ name: 'R135 spawn', serverUrl, serverIdentityId: input.executionTarget.serverId,
            accountId: 'owner', currentAccount: true, active: false });
        account = await captureLazyActionAccountContext(serverId);
        await answerExternalActionAccountForHome(homes, serverId, { machineId: input.executionTarget.machineId,
            tokenEpoch: 0, actionId: 'session.spawn_new',
            execute: async (received, context) => {
                const bound = await bindCallerInput(getActionSpec('session.spawn_new'), received, {
                    surface: context.invocation.surface, actionCaller: context.invocation.caller,
                    serverId: input.executionTarget.serverId, externalActionTarget: context.target,
                });
                return bound.ok ? bound.input : bound;
            },
            failure: value => {
                const parsed = ActionExecuteFailureSchema.safeParse(value);
                return parsed.success ? parsed.data : null;
            },
        });
        if (!account) throw new Error('Expected captured R135 Account');
        const result = await executeOriginalAccountMachineAction({ account, input, actionId: 'session.spawn_new',
            requestId: `r135-spawn-${surface}`, machineId: input.executionTarget.machineId,
            authority: 'account_automation', invocation: { caller: { kind: 'host' }, surface, authority: 'account_automation' } });
        const { observeSessionCommit: _observer, ...terminalInput } = input;
        expect(result, JSON.stringify(result)).toEqual({ ok: true, result: terminalInput });
    });
    it.each([
        { creator: true, intent: 'delete', accountMode: 'plain' },
        { creator: true, intent: 'delete', accountMode: 'e2ee' },
        { creator: false, intent: 'delete', accountMode: 'e2ee' },
        { creator: false, intent: 'stop', accountMode: 'e2ee' },
    ] as const)('runs admitted $intent without sharing Account material ($accountMode, creator=$creator)', async ({ creator, intent, accountMode }) => {
        if (!account) throw new Error('Expected captured Account');
        if (accountMode === 'e2ee') {
            const credentials = { ...account.credentials, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') };
            account.dispose();
            serverId = await homes.addHome({ name: 'Encrypted plugin transport', serverUrl: 'https://encrypted-plugin-transport.test',
                serverIdentityId: binding.serverIdentityId, accountId: 'owner', currentAccount: true,
                accountEncryptionMode: 'e2ee', credentials });
            homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
            account = await captureLazyActionAccountContext(serverId);
        }
        const { encryption } = await account.resolveAccountEncryption();
        const material = encryption ? { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() } : undefined;
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
        const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
        const requestId = 'managed-control';
        const input = { homeId: binding.serverIdentityId, managedId: 'created-guest', when: 'now',
            expectedRevision: 0, intent, ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-delete-proof', binding: {
                ...binding, actionId, requestId, machineId: 'machine-1', installationId: 'installation-1',
                custodianAccountId: 'custodian', accountEncryptionMode: accountMode,
                managedAdmission: { ...projectExternalActionManagedAdmissionV1(actionId, input),
                    ...(creator ? { authority: 'creator_recovery' } : {}) },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        let boundaryFailure: unknown;
        homes.answer(serverId, actionPath, { select: body => {
            try {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const authorization = request.executionAuthorization;
            if (!authorization) throw new Error('Missing admitted managed control');
            const recipient = { authorization, serverIdentityId: binding.serverIdentityId, machineId: 'machine-1',
                installationId: 'installation-1', installationPrivateKey: keys.secretKey };
            const codec = openManagedControllerActionCodecV1(recipient);
            expect(codec).not.toBeNull();
            if (codec && material) expect(codec.machineKey).not.toEqual(material.machineKey);
            if (request.envelope.v === 2) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                envelope: request.envelope, binding: { ...binding, actionId, requestId }, material: codec ?? material! })).toEqual({ input });
            const requester = openExternalActionRequesterAccountContextV1({ ...recipient, purpose: { kind: 'external_action' } });
            expect(requester).toBeNull();
            const execution = { ok: true as const, result: { kind: 'accepted', managedId: input.managedId, intentRevision: 1 } };
            return { body: request.envelope.v === 2 ? prepareExternalActionResponseV2({ binding: { ...binding, actionId, requestId },
                request: request.envelope, material: codec ?? material!, randomBytes: getRandomBytes, executedMachineId: 'machine-1', execution }).response
                : { v: 1, actionId, requestId, execution } };
            } catch (error) { boundaryFailure = error; throw error; }
        } });
        const result = await executeOriginalAccountActionTransport({ account, binding: { ...binding, actionId, requestId }, input,
            ...(material ? { material } : {}),
            authority: 'present_user', invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
            machineCustody: { accountMode, installationId: 'installation-1', installationPublicKey: keys.publicKey,
                custodian: { accountId: 'custodian' } },
        });
        expect(boundaryFailure).toBeUndefined();
        expect(result).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: input.managedId } });
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
    });
    it('sends unbound host repair Actions through the Home action.invoke owner', async () => {
        const row = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: 'owner' }), installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === row.id ? row : null).json(),
        }) });
        homes.answer(serverId, '/v1/actions/action.invoke', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.input).toEqual({ action: { pluginId: 'happier.machine.crabbox', localId: 'install' }, input: {} });
            return { body: { v: 1, actionId: 'action.invoke', requestId: envelope.requestId,
                execution: { ok: true, result: { installed: true } } } };
        } });
        expect(await machinePluginStructuredMessageActionExecute(row.id, { serverId,
            qualifiedActionId: 'happier.machine.crabbox/install', expectedContributorOccurrenceId: 'crabbox-current',
            executionSurface: 'ui', input: {}, presentUserIntent: 'confirmed',
        })).toEqual({ supported: true, result: { ok: true, result: { installed: true } } });
        expect(homes.requestsFor('/v1/actions/action.invoke')).toHaveLength(1);
    });
    it('refuses a prepared placement on another Machine before requesting execution authority', async () => {
        if (!account) throw new Error('Expected captured Account');
        answerOwnedMachine();
        const selectedTarget = { serverId, machineId: 'another-machine' };
        await expect(executeOriginalAccountMachineAction({ account, actionId: 'session.spawn_new',
            requestId: 'placement-mismatch', authority: 'present_user', machineId: 'machine-1',
            input: { executionTarget: selectedTarget, sessionPlacement: { kind: 'machine', target: selectedTarget },
                directory: { kind: 'path', path: '/tmp' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        })).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ['sessionPlacement'] })] });
        expect(homes.requestsFor('/v1/actions/session.spawn_new/execution-authorization')).toEqual([]);
        expect(homes.requestsFor('/v1/actions/session.spawn_new')).toEqual([]);
    });
    it.each(['preset', 'shared', 'owned-spawn', 'delegated-accepted', 'delegated-declined', 'delegated-automation'] as const)('dispatches Home-admitted finite custody without controller inventory (%s)', async recipient => {
        if (!account) throw new Error('Expected captured Account');
        const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
        const row = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: recipient === 'shared' ? 'custodian' : 'owner' }),
            installationId: 'installation-1', installationPublicKey: encodeBase64(guestKeys.publicKey),
            ...(recipient === 'owned-spawn' ? { managedMachineRef: { homeId: binding.serverIdentityId, managedId: 'managed-guest' } } : {}),
            access: { custodian: { accountId: recipient === 'shared' ? 'custodian' : 'owner', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } };
        disclosureConsent.mockResolvedValue(recipient !== 'delegated-declined');
        let controllerReads = 0;
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => {
                if (id === row.id && recipient !== 'preset') return row;
                controllerReads++;
                return null; // Can use on the guest grants no access to its controller.
            }).json(),
        }) });
        const spawn = recipient === 'shared' || recipient === 'owned-spawn' || recipient === 'preset';
        const actionId = spawn ? 'session.spawn_new' : 'projects.script.run';
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const sync = request.envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(actionId, request.envelope.input)
                : request.envelope.workspaceSyncAdmission;
            const minted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-spawn-proof', binding: { ...binding, actionId,
                target: request.envelope.target,
                machineId: row.id, installationId: row.installationId,
                custodianAccountId: row.access.custodian.accountId, accountEncryptionMode: 'plain',
                ...(request.envelope.sessionSpawnAdmission?.managedPresetAcquisition
                    ? { sessionPresetAcquisition: request.envelope.sessionSpawnAdmission.managedPresetAcquisition } : {}),
                machineRuntimeDemand: 'required',
                ...(sync ? { workspaceSyncAdmission: { relationshipId: sync.relationshipId ?? deriveWorkspaceSyncRelationshipId(binding.requestId),
                    sourceWorkspaceRefId: sync.sourceWorkspaceRefId,
                    source: { actorAccountId: 'owner', custodianAccountId: row.access.custodian.accountId,
                        machineId: sync.sourceMachineId, installationId: row.installationId, role: 'use', encryptionMode: 'plain' } } } : {}),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) },
                managedFiniteWake: { target: { homeId: binding.serverIdentityId, managedId: 'managed-guest',
                    enrolledMachineId: row.id, expectedIntentRevision: 0,
                    controller: { machineId: 'private-controller', installationId: 'controller-installation' },
                    reason: 'admitted-work', origin: { kind: 'finite-command', actionRequestId: binding.requestId } },
                    installationPublicKey: encodeBase64(controllerKeys.publicKey, 'base64url'),
                    ...(recipient !== 'shared' ? { requesterCredentialDisclosure: { accountId: 'custodian', displayName: 'Custodian' } } : {}) } });
            expect(isExternalActionAuthorizationBoundToEnvelope(minted.binding, { actionId, machineId: row.id, envelope: request.envelope }),
                JSON.stringify({ binding: minted.binding, envelope: request.envelope })).toBe(true);
            return { body: minted };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const authorization = request.executionAuthorization;
            if (!authorization?.managedFiniteWake) throw new Error('Expected admitted wake custody');
            for (const recipient of [
                { machineId: row.id, installationId: row.installationId, installationPrivateKey: guestKeys.secretKey,
                    purpose: { kind: 'external_action' } as const },
                { machineId: 'private-controller', installationId: 'controller-installation', installationPrivateKey: controllerKeys.secretKey,
                    purpose: { kind: 'managed_finite_wake', target: authorization.managedFiniteWake.target } as const },
            ].filter(target => target.machineId !== row.id || row.access.custodian.accountId !== 'owner')) expect(openExternalActionRequesterAccountContextV1({ authorization, serverIdentityId: binding.serverIdentityId,
                ...recipient })).toMatchObject({ token: account?.credentials.token });
            expect(JSON.stringify(body)).not.toContain(account?.credentials.token);
            return { body: { v: 1, actionId, requestId: binding.requestId,
                execution: { ok: true, result: { type: 'success', sessionId: 'created-session' } } } };
        } });
        const result = await executeOriginalAccountMachineAction({ account, actionId, requestId: binding.requestId,
            ...(recipient === 'preset' ? { invocation: { caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const,
                sessionCreationDefaults: { context: buildManagedSessionDefaultsContext({}), authoredChoices: {},
                    managedPresetAcquisition: { selection: { kind: 'preset' as const, homeId: binding.serverIdentityId, id: 'selected-preset', revision: 1 },
                        controller: { machineId: row.id, installationId: row.installationId } },
                    managedPresetControllerAccess: { installationPublicKey: encodeBase64(guestKeys.publicKey, 'base64url'), custodian: { accountId: row.access.custodian.accountId } },
                } } } : {}),
            authority: recipient === 'delegated-automation' ? 'account_automation' : 'present_user',
            machineId: row.id, input: !spawn ? { workspace: { serverId, workspaceId: 'workspace', machineId: row.id, rootPath: '/tmp' },
                selection: { kind: 'named', name: 'test' } } : projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
                creationKey: 'shared-guest-spawn', executionTarget: { serverId, machineId: row.id },
                ...(recipient === 'shared' ? { sessionPlacement: { kind: 'machine', target: { serverId, machineId: row.id } } } : {}),
                ...(recipient === 'preset' ? { sessionPlacement: { kind: 'preset', homeId: binding.serverIdentityId, presetId: 'selected-preset' } } : {}),
                directory: { kind: 'path', path: '/tmp' }, permissionMode: 'default',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            })) });
        expect(homes.requestsFor(`${actionPath}/execution-authorization`), JSON.stringify(result)).toHaveLength(1);
        expect(controllerReads).toBe(0);
        expect(disclosureConsent, JSON.stringify(result)).toHaveBeenCalledTimes(recipient === 'shared' || recipient === 'delegated-automation' ? 0 : 1);
        if (recipient === 'delegated-declined' || recipient === 'delegated-automation') {
            expect(homes.requestsFor(actionPath)).toHaveLength(0);
            expect(result).toMatchObject({ ok: false, errorCode: recipient === 'delegated-automation'
                ? 'requester_account_material_unavailable' : 'requester_credential_disclosure_declined' });
        } else expect(result).toMatchObject({ ok: true, result: { sessionId: 'created-session' } });
    });
    it.each(['matching', 'mismatched'] as const)('preserves the Machine availability cause and remedy with %s request correlation', async correlation => {
        const diagnostic = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
        const refusal = { error: 'invalid_request', code: 'target_unavailable',
            requestId: correlation === 'matching' ? binding.requestId : 'other-request', diagnostic };
        homes.answer(serverId, path, { status: 409, body: refusal });
        expect(await execute()).toMatchObject(correlation === 'matching'
            ? { ok: false, errorCode: 'target_unavailable', effectAttempted: false, details: diagnostic }
            : { ok: false, errorCode: 'invalid_action_output' });
    });
    it('marks an authenticated pre-open refusal as having attempted no effect', async () => {
        const refusal = projectExternalActionHttpError('credential_scope_denied');
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'credential_scope_denied', effectAttempted: false });
    });
    it.each(['mint', 'effect'] as const)('preserves the Machine Manage cause at %s before credential disclosure', async stage => {
        if (!account) throw new Error('Expected captured Account');
        const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
            errorCode: 'machine_manage_required', httpStatus: null } as const;
        const refusal = projectExternalActionHttpError('credential_scope_denied', undefined, undefined,
            undefined, undefined, undefined, failureCause);
        homes.answer(serverId, stage === 'mint' ? `${path}/execution-authorization` : path,
            { status: refusal.statusCode, body: refusal.payload });
        const result = await executeOriginalAccountActionTransport({ account, binding, input: {}, authority: 'present_user',
            ...(stage === 'mint' ? { machineCustody: { accountMode: 'plain' as const,
                installationId: 'installation-1', custodian: { accountId: 'foreign-owner' },
                installationPublicKey: nacl.box.keyPair().publicKey } } : {}) });
        expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied', effectAttempted: false, failureCause });
        expect(disclosureConsent).not.toHaveBeenCalled();
        if (stage === 'mint') expect(homes.requestsFor(path)).toHaveLength(0);
    });
    it('mints retained managed follow-up authorization even for the requester own ordinary Machine', async () => {
        if (!account) throw new Error('Expected captured Account');
        answerOwnedMachine();
        const actionId = 'machines.setup.plan';
        const requestId = 'retained-setup-1';
        const actionPath = `/v1/actions/${actionId}`;
        const managedContinuation = { managedId: 'managed-1', creationRequestId: 'create-1', expectedIntentRevision: 0 };
        let admittedContinuation: unknown;
        let forwardedEnvelope: unknown;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            admittedContinuation = request.managedContinuation;
            return { body: { v: 1, token: 'home-managed-follow-up-proof', binding: {
                ...binding, actionId, requestId, machineId: 'machine-1', installationId: 'installation-1',
                custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                managedContinuation: { ...managedContinuation,
                    acquireRequestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) },
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            forwardedEnvelope = body;
            return { body: { v: 1, actionId, requestId, execution: { ok: true, result: { accepted: true } } } };
        } });
        const request = { account, machineId: 'machine-1', actionId, requestId,
            input: { homeId: binding.serverIdentityId, machineId: 'machine-1' }, managedContinuation };
        expect(await executeOriginalAccountMachineAction(request)).toEqual({ ok: true, result: { accepted: true } });
        expect(admittedContinuation).toEqual(managedContinuation);
        expect(forwardedEnvelope).toMatchObject({ executionAuthorization: { token: 'home-managed-follow-up-proof' } });
    });
    it('does not dispatch retained managed follow-up when Home refuses authorization', async () => {
        if (!account) throw new Error('Expected captured Account');
        answerOwnedMachine();
        const actionId = 'machines.setup.plan';
        const requestId = 'refused-managed-setup';
        const actionPath = `/v1/actions/${actionId}`;
        const refusal = projectExternalActionHttpError('action_not_admitted', requestId);
        homes.answer(serverId, `${actionPath}/execution-authorization`, { status: refusal.statusCode, body: refusal.payload });
        expect(await executeOriginalAccountMachineAction({ account, actionId, requestId, machineId: 'machine-1',
            input: { homeId: binding.serverIdentityId, machineId: 'machine-1' },
            managedContinuation: { managedId: 'managed-1', creationRequestId: 'create-1', expectedIntentRevision: 0 } }))
            .toMatchObject({ ok: false, errorCode: 'action_not_admitted' });
        expect(homes.requestsFor(actionPath)).toHaveLength(0);
    });
    it.each(['target-active', 'another-active'] as const)('keeps the mounted Services list loading until an admitted empty or unavailable answer settles (%s)', async focus => {
        const { storage } = await import('@/sync/domains/state/storage');
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const priorStorage = storage.getState();
        const priorSnapshot = runtime.getAppliedActiveServerSnapshot();
        const priorAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        await initializeRealAppRuntimeForTests();
        installHomeGovernanceBoundaries(homes);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        const focusedHome = focus === 'target-active' ? serverId : await homes.addHome({
            name: 'Other focused Home', serverUrl: 'https://other-services-home.test',
            serverIdentityId: 'srv_other_services', accountId: 'other-owner', currentAccount: true, active: false,
        });
        await setActiveServerId(focusedHome, { scope: 'device' });
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://plugin-transport.test', { serverId });
        if (!credentials) throw new Error('Services list Home credentials unavailable');
        const focusedCredentials = focusedHome === serverId ? credentials : await TokenStorage.getCredentialsForServerUrl(
            'https://other-services-home.test', { serverId: focusedHome });
        if (!focusedCredentials) throw new Error('Focused Home credentials unavailable');
        await restoreConnectionToActiveServer(focusedCredentials);
        const actionId = 'machines.services.list';
        const actionPath = `/v1/actions/${actionId}`;
        const input = { serverId, machineId: 'machine-1' };
        const row = { ...createPlainMachineRowFixture({ id: input.machineId, accountId: 'owner' }), installationId: 'installation-1' };
        answerOwnedMachine();
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-list-loading-proof', binding: { ...binding, actionId, requestId: envelope.requestId,
                machineId: input.machineId, installationId: row.installationId, custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } } };
        } });
        let finishRead!: () => void;
        const readGate = new Promise<void>(resolve => { finishRead = resolve; });
        let heldReads = 0;
        let resourceReads = 0;
        let invalidate: (() => void) | undefined;
        let current: { kind: 'snapshot'; services: [] } | { kind: 'unavailable'; reason: 'admission_unavailable' } = { kind: 'snapshot', services: [] };
        const content = () => { const bytes = Buffer.from(JSON.stringify(current)); return { contentType: 'application/json',
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytesBase64: bytes.toString('base64') }; };
        if (!account) throw new Error('Captured Services list Account unavailable');
        const rpcInput = { ...input, serverId: account.serverId };
        let checkingAddressedFrontDoor = true;
        // The incumbent finite list uses Machine RPC, while the replacement Resource
        // uses the original-Account HTTP Action. Both stop at their real network edge.
        const socketBoundary = installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
                    || !('method' in payload) || payload.method !== `${input.machineId}:${actionId}`
                    || !('params' in payload)) throw new Error('Unexpected Services list Socket.IO request');
                expect(payload.params).toEqual(rpcInput);
                if (checkingAddressedFrontDoor) return { ok: true, result: current };
                heldReads++;
                await readGate;
                return { ok: true, result: current };
            });
        }, { serverUrl: 'https://plugin-transport.test', token: credentials.token });
        homes.answer(serverId, actionPath, { select: async (body, request) => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            const reply = (result: unknown) => ({ body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
            const continuation = envelope.resourceContinuation;
            if (!continuation) { heldReads++; await readGate; return reply(current); }
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
                heldReads++; resourceReads++; await readGate; return reply({ ok: true, resource: continuation.params.resource, ...content() });
            }
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
                return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT)
                return new Promise<ReturnType<typeof reply>>(resolve => {
                    const subscriptionId = continuation.params.subscriptionId;
                    const finish = (value: unknown) => { invalidate = undefined;
                        request.signal?.removeEventListener('abort', aborted); resolve(reply(value)); };
                    const aborted = () => finish({ ok: true, status: 'idle' });
                    invalidate = () => finish({ ok: true, status: 'event', event: {
                        version: 1, kind: 'invalidated', subscriptionId, digest: content().digest,
                    } });
                    request.signal?.addEventListener('abort', aborted, { once: true });
                    if (request.signal?.aborted) aborted();
                });
            return reply({ ok: true, closed: true });
        } });
        const { useMachineServicesList } = await import('@/components/machines/services/useMachineServices');
        const observations: Array<ReturnType<typeof useMachineServicesList>> = [];
        let unmount = async () => {};
        try {
            // An explicitly addressed Home remains reachable while another Home
            // owns focused Sync. The Resource cannot narrow that existing contract.
            const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
            expect(await createFrontDoorActionExecute()(actionId, input,
                { surface: 'ui', authority: 'present_user', serverId })).toMatchObject({ ok: true, result: current });
            checkingAddressedFrontDoor = false;
            const hook = await renderHook(() => { const value = useMachineServicesList({ ...input, active: true });
                observations.push(value); return value; });
            unmount = () => hook.unmount();
            await vi.waitFor(() => expect(heldReads, JSON.stringify({
                states: observations.map(value => ({ pending: value.pending, errorCode: value.error?.code, unavailable: value.unavailable })),
                requests: homes.requests.map(request => ({ method: request.method, path: request.path })),
            })).toBeGreaterThan(0));
            expect(observations.length).toBeGreaterThan(0);
            expect(observations.every(value => value.pending && value.rows === null && value.unavailable === null)).toBe(true);
            await act(async () => { finishRead(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: [], unavailable: null, pending: false }));
            await vi.waitFor(() => expect(invalidate).toBeTypeOf('function'));
            const beforeInvalidation = resourceReads;
            current = { kind: 'unavailable', reason: 'admission_unavailable' };
            await act(async () => { invalidate?.(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: null, unavailable: 'admission_unavailable', pending: false }));
            // This is the client READ half of the existing digest-then-READ transport.
            expect(resourceReads).toBe(beforeInvalidation + 1);
        } finally {
            finishRead();
            await unmount();
            socketBoundary.dispose();
            await disconnectActiveServerConnection();
            storage.setState(priorStorage, true);
            runtime.publishAppliedActiveServerSnapshot(priorSnapshot, priorAvailable);
        }
    });
    it('does no hidden first-read work and never exposes a prior generation in a mounted logs hook', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const priorStorage = storage.getState();
        const priorSnapshot = runtime.getAppliedActiveServerSnapshot();
        const priorAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        await initializeRealAppRuntimeForTests();
        installHomeGovernanceBoundaries(homes);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await setActiveServerId(serverId, { scope: 'device' });
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://plugin-transport.test', { serverId });
        if (!credentials) throw new Error('Log generation Home credentials unavailable');
        await restoreConnectionToActiveServer(credentials);
        const actionId = 'machines.services.logs.read';
        const input = { serverId, machineId: 'machine-1', serviceId: 'worker' };
        const row = { ...createPlainMachineRowFixture({ id: input.machineId, accountId: 'owner' }), installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-hook-log-generation', binding: {
                ...binding, actionId, requestId: envelope.requestId, machineId: input.machineId,
                installationId: row.installationId, custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        let logText = 'old generation output';
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: {
                kind: 'page', page: { sourceRevision: 'source', text: logText, nextCursor: null, truncated: false },
            } } } };
        } });
        const { useMachineServiceFirstLogRead } = await import('@/components/machines/services/useMachineServices');
        const observations: Array<{ generation: string | null; state: ReturnType<typeof useMachineServiceFirstLogRead>['state'] }> = [];
        const hook = await renderHook<ReturnType<typeof useMachineServiceFirstLogRead>, Parameters<typeof useMachineServiceFirstLogRead>[0]>(props => {
            const value = useMachineServiceFirstLogRead(props);
            observations.push({ generation: props.expectedGeneration, state: value.state });
            return value;
        }, { initialProps: { ...input, expectedGeneration: 'generation-1', active: false } });
        try {
            await act(async () => { await hook.getCurrent().read(); });
            expect(homes.requestsFor(actionPath)).toHaveLength(0);
            await hook.rerender({ ...input, expectedGeneration: 'generation-1', active: true });
            await act(async () => { await hook.getCurrent().read(); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'read', value: { page: { text: 'old generation output' } } });
            await hook.rerender({ ...input, expectedGeneration: 'generation-2', active: true });
            expect(observations.filter(value => value.generation === 'generation-2').every(value => value.state.kind !== 'read')).toBe(true);
            expect(homes.requestsFor(actionPath)).toHaveLength(1);
            await act(async () => { await hook.getCurrent().read(); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'read' });
            await hook.rerender({ ...input, expectedGeneration: null, active: true });
            expect(observations.filter(value => value.generation === null).every(value => value.state.kind !== 'read')).toBe(true);
            await act(async () => { await hook.getCurrent().read(); });
            expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
            expect(homes.requestsFor(actionPath)).toHaveLength(2);
            await hook.rerender({ ...input, expectedGeneration: 'generation-2', active: true });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'read' });
            const retiredLifetime = hook.getCurrent().accountLifetime;
            if (!retiredLifetime) throw new Error('Expected the requested Home credential lifetime');
            // Retire the requested Home through its real credential owner, not
            // ambient focused-runtime publications that this binding ignores.
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl('https://plugin-transport.test', { serverId })).toBe(true);
            });
            expect(retiredLifetime.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().accountLifetime).toBeNull());
            expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
            expect(JSON.stringify(hook.getCurrent().state)).not.toContain('old generation output');
            await hook.rerender({ ...input, expectedGeneration: 'generation-2', active: false });
            await act(async () => { await hook.getCurrent().read(); });
            expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
            expect(homes.requestsFor(actionPath)).toHaveLength(2);
            logText = 'fresh credential output';
            await act(async () => { await homes.switchAccount(serverId, 'owner', { currentAccount: true }); });
            await vi.waitFor(() => expect(hook.getCurrent().accountLifetime?.isCurrent()).toBe(true));
            expect(hook.getCurrent().accountLifetime).not.toBe(retiredLifetime);
            expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
            expect(homes.requestsFor(actionPath)).toHaveLength(2);
            await hook.rerender({ ...input, expectedGeneration: 'generation-2', active: true });
            await act(async () => { await hook.getCurrent().read(); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'read', value: { page: { text: 'fresh credential output' } } });
            expect(homes.requestsFor(actionPath)).toHaveLength(3);
        } finally {
            await hook.unmount();
            await disconnectActiveServerConnection();
            storage.setState(priorStorage, true);
            runtime.publishAppliedActiveServerSnapshot(priorSnapshot, priorAvailable);
        }
    });

    it.each(['matching', 'receipt', 'mismatched', 'malformed'] as const)('preserves the Machine availability mint refusal through the UI logs Action (%s)', async reply => {
        if (!account) throw new Error('Expected captured Account');
        const actionId = 'machines.services.logs.read';
        const input = { serverId, machineId: 'machine-1', serviceId: 'worker' };
        const diagnostic = { reason: 'machine_installation_missing', requiredFact: 'machine_installation', remedy: 'register_machine' };
        const row = { ...createPlainMachineRowFixture({ id: input.machineId, accountId: 'owner' }), installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { status: 409, body: { error: 'invalid_request', code: 'target_unavailable',
                requestId: reply === 'mismatched' ? 'another-request' : request.envelope.requestId,
                ...(reply === 'receipt' ? { managedAdmission: { managedId: 'managed-machine' } } : {}),
                diagnostic: reply === 'malformed' ? { ...diagnostic, machineId: 'private-identifier' } : diagnostic } };
        } });
        const result = await executeOriginalAccountMachineAction({ account, actionId, input,
            requestId: 'ui-machine-availability-mint', machineId: input.machineId,
            machineServiceLogsGeneration: { expectedGeneration: 'selected-native-generation' } });
        expect(result).toMatchObject(reply === 'matching' || reply === 'receipt'
            ? { ok: false, errorCode: 'target_unavailable', effectAttempted: false, details: reply === 'receipt'
                ? { error: 'invalid_request', code: 'target_unavailable', requestId: 'ui-machine-availability-mint',
                    managedAdmission: { managedId: 'managed-machine' }, diagnostic } : diagnostic }
            : { ok: false, errorCode: 'admission_unavailable' });
        if (reply === 'mismatched' || reply === 'malformed') expect(result).not.toHaveProperty('details');
        expect(homes.requestsFor(`${actionPath}/execution-authorization`)).toHaveLength(1);
        expect(homes.requestsFor(actionPath)).toHaveLength(0);
    });

    it('keeps the selected native generation through the real UI logs front door', async () => {
        const actionId = 'machines.services.logs.read';
        const input = { serverId, machineId: 'machine-1', serviceId: 'worker' };
        const machineServiceLogsGeneration = { expectedGeneration: 'selected-native-generation' };
        const row = { ...createPlainMachineRowFixture({ id: input.machineId, accountId: 'owner' }),
            installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionPath = `/v1/actions/${actionId}`;
        let receivedEnvelope: unknown;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-selected-log-generation', binding: {
                ...binding, actionId, requestId: envelope.requestId, machineId: input.machineId,
                installationId: row.installationId, custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        const page = { kind: 'page', page: { sourceRevision: 'source', text: 'current output', nextCursor: null, truncated: false } };
        homes.answer(serverId, actionPath, { select: body => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            receivedEnvelope = envelope;
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: page } } };
        } });
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        expect(await createFrontDoorActionExecute()(actionId, input, { surface: 'ui', serverId,
            expectedAccountId: 'owner', machineServiceLogsResource: machineServiceLogsGeneration }))
            .toEqual({ ok: true, result: page });
        expect(receivedEnvelope).toMatchObject({ input, machineServiceLogsGeneration });
        expect(receivedEnvelope).not.toHaveProperty('resourceContinuation');
    });

    it('routes a native host Resource read through its original Account logs Action', async () => {
        const actionId = 'machines.services.logs.read';
        const resource = { hostRead: 'machines.services.logs' as const,
            input: { serverId, machineId: 'machine-1', serviceId: 'worker' },
            expectedGeneration: 'generation', sourceRevision: 'source' };
        const row = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: 'owner' }),
            installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-resource-proof', binding: {
                ...binding, actionId, requestId: envelope.requestId, machineId: 'machine-1', installationId: 'installation-1',
                custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        const result = { ok: true, resource, contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
            bytesBase64: 'e30=' };
        homes.answer(serverId, actionPath, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
        } });
        expect(await machinePluginUiResourceRead('machine-1', { serverId, accountId: 'owner', resource }))
            .toEqual({ supported: true, result });
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
    });

    it('binds native logs continuation and generation into the exact Home-minted original invocation', async () => {
        if (!account) throw new Error('Expected captured Account');
        const logsBinding = { ...binding, actionId: 'machines.services.logs.read', requestId: 'logs-resource-read' };
        const input = { serverId, machineId: 'machine-1', serviceId: 'worker',
            cursor: { sourceRevision: 'native-source-1', token: 'selected-cursor' } };
        const resource = { hostRead: 'machines.services.logs' as const, input,
            expectedGeneration: 'generation-1', sourceRevision: 'native-source-1' };
        const resourceContinuation = { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            params: { machineId: input.machineId, resource } };
        const machineServiceLogsGeneration = { expectedGeneration: resource.expectedGeneration };
        const actionPath = `/v1/actions/${logsBinding.actionId}`;
        const installation = nacl.sign.keyPair();
        let mintedEnvelope: unknown;
        let receivedEnvelope: unknown;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            mintedEnvelope = envelope;
            return { body: { v: 1, token: 'home-native-logs-proof', binding: {
                ...logsBinding, machineId: 'machine-1', installationId: 'installation-1', custodianAccountId: 'owner',
                accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            receivedEnvelope = typeof body === 'object' && body !== null && 'envelope' in body ? body.envelope : body;
            return { body: { v: 1, actionId: logsBinding.actionId, requestId: logsBinding.requestId,
                execution: { ok: true, result: { accepted: true } } } };
        } });
        const request = { account, binding: logsBinding, input, resourceContinuation, machineServiceLogsGeneration,
            machineCustody: { accountMode: 'plain' as const, installationId: 'installation-1',
                installationPublicKey: installation.publicKey, custodian: { accountId: 'owner' } } };
        expect(await executeOriginalAccountActionTransport(request)).toEqual({ ok: true, result: { accepted: true } });
        expect(mintedEnvelope).toMatchObject({ input, resourceContinuation, machineServiceLogsGeneration });
        expect(receivedEnvelope).toEqual(mintedEnvelope);
    });

    it('checks the app demand in Home proof before forwarding requester custody', async () => {
        if (!account) throw new Error('Expected captured Account');
        const appBinding = { ...binding, actionId: 'registries.updates.check', requestId: 'app-update' };
        const input = { kind: 'app', environments: [{ environmentId: 'selected', expectedRevision: 3 }] };
        const actionPath = '/v1/actions/registries.updates.check';
        const keys = nacl.sign.keyPair();
        let variant: 'missing' | 'substituted' | 'current' = 'missing';
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            const demand = projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1({ actionId: appBinding.actionId, envelope });
            return { body: { v: 1, token: 'home-app-proof', binding: {
                ...appBinding, machineId: 'machine-1', installationId: 'installation-1', custodianAccountId: 'custodian',
                accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(variant === 'missing' ? {} : { registryAppUpdateAdmission: variant === 'current' ? demand
                    : { environments: [{ environmentId: 'another', expectedRevision: 3 }] } }),
            } } };
        } });
        homes.answer(serverId, actionPath, { body: { v: 1, actionId: appBinding.actionId,
            requestId: appBinding.requestId, execution: { ok: true, result: { checkedAt: 1, results: [] } } } });
        const captured = account;
        const call = () => executeOriginalAccountActionTransport({ account: captured, binding: appBinding, input,
            machineCustody: { accountMode: 'plain', installationId: 'installation-1', installationPublicKey: keys.publicKey,
                custodian: { accountId: 'custodian' } } });
        for (const invalid of ['missing', 'substituted'] as const) {
            variant = invalid;
            expect(await call()).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        }
        expect(homes.requestsFor(actionPath)).toHaveLength(0);
        variant = 'current';
        expect(await call()).toMatchObject({ ok: true, result: { checkedAt: 1, results: [] } });
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
    });

    it('reads only the exact Action Machine rather than the Account Machine census', async () => {
        const machines = Array.from({ length: 100 }, (_, index) => createPlainMachineRowFixture({ id: `machine-${index}`, accountId: 'owner' }));
        homes.answer(serverId, '/v1/machines', { body: machines });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => machines.find(machine => machine.id === id) ?? null).json(),
        }) });
        if (!account) throw new Error('Expected captured Account');
        expect(await readOriginalAccountActionMachine(account, 'machine-42')).toMatchObject({ id: 'machine-42' });
        expect(homes.requests.filter(request => new URL(request.path, 'https://plugin-transport.test').pathname === '/v1/machines')).toHaveLength(0);
        expect(homes.requestsFor('/v1/machines/read-batch').map(request => request.input)).toEqual([{ machineIds: ['machine-42'] }]);
    });

    it('refuses private Machine discovery without a captured Account read transport', async () => {
        if (!account) throw new Error('Expected captured Account');
        const before = homes.requests.length;
        expect(await readOriginalAccountActionMachine({ ...account, readTransport: undefined }, 'machine-1')).toBeNull();
        expect(homes.requests.slice(before)).toHaveLength(0);
    });

    it('preserves Account page source and version through the real Machine Action envelope', async () => {
        answerOwnedMachine();
        const mountedBinding = { pluginId: 'com.acme.portable', contributionLocalId: 'page', occurrenceId: 'account-custody',
            pluginVersion: '1.0.0', sourceCustody: { kind: 'bundled_first_party' as const,
                packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/portable' } } };
        homes.answer(serverId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.pluginInvocation).toEqual({ kind: 'mountedPluginSurface', mountedBinding });
            return { body: { v: 1, actionId: binding.actionId, requestId: envelope.requestId,
                execution: { ok: true, result: { completed: true } } } };
        } });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountMachineAction({ account, machineId: 'machine-1', actionId: binding.actionId,
            requestId: binding.requestId, input: {}, actionCaller: { kind: 'plugin', ...mountedBinding } })).toMatchObject({ ok: true, result: { completed: true } });
    });
    it('carries an Account surface declaration through Action dispatch and the canonical executor into the Machine envelope', async () => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { dispatchPluginSurfaceAction } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
        const capturedAccount = account;
        if (!capturedAccount) throw new Error('Expected captured Account');
        answerOwnedMachine();
        const mountedBinding = { pluginId: 'com.acme.portable', contributionLocalId: 'page', occurrenceId: 'account-custody',
            pluginVersion: '1.0.0', sourceCustody: { kind: 'bundled_first_party' as const,
                packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/portable' } } };
        let receivedInvocation: unknown;
        homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            receivedInvocation = envelope.pluginInvocation;
            return { body: { v: 1, actionId: 'plugins.list', requestId: envelope.requestId,
                execution: { ok: true, result: { ok: true, kind: 'plugins_list', plugins: [] } } } };
        } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            // The native plugin-management effect leaves through its real HTTP adapter.
            pluginsDevLoopAction: async ({ actionId, input, context }) => {
                const result = await executeOriginalAccountMachineAction({ account: capturedAccount, machineId: 'machine-1',
                    requestId: 'page-dispatch', actionId, input, actionCaller: context.actionCaller });
                return result.ok ? result.result : result;
            },
        }));
        expect(await dispatchPluginSurfaceAction({ callerPluginId: mountedBinding.pluginId, callerContributionLocalId: 'page',
            callerBinding: mountedBinding, action: 'plugins.list', input: {}, hostAction: { execute: executor.execute } }))
            .toEqual({ ok: true, result: { ok: true, kind: 'plugins_list', plugins: [] } });
        expect(receivedInvocation).toEqual({ kind: 'mountedPluginSurface', mountedBinding });
    });
    it.each(['action_not_admitted', 'action_outcome_unknown'] as const)('preserves request correlation for %s and refuses a mismatched reply', async code => {
        const refusal = projectExternalActionHttpError(code, binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: code, details: { requestId: binding.requestId } });
        homes.answer(serverId, path, { status: refusal.statusCode,
            body: projectExternalActionHttpError(code, 'another-request').payload });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {} }))
            .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('projects native optional members before the strict envelope for other app Action families', async () => {
        homes.answer(serverId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.input).toEqual({ machineId: 'machine-1', pluginId: 'example.plugin',
                options: { enabled: false, selection: null } });
            return { body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } };
        } });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {
            machineId: 'machine-1', pluginId: 'example.plugin', optional: undefined,
            options: { optional: undefined, enabled: false, selection: null },
        } })).toEqual({ ok: true, result: { completed: true } });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it.each([new Map(), [undefined], { callback: () => true }])('refuses genuinely non-JSON input before HTTP issuance (%j)', async invalid => {
        if (!account) throw new Error('Expected captured Account');
        const onTransportIssued = vi.fn();
        expect(await executeOriginalAccountActionTransport({ account, binding,
            input: { invalid }, onTransportIssued })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(homes.requestsFor(path)).toEqual([]);
        expect(onTransportIssued).not.toHaveBeenCalled();
    });

    it('keeps non-spawn Action lifetime independent from the Session startup budget', async () => {
        let release!: () => void;
        homes.answer(serverId, path, { respondAfter: new Promise<void>(resolve => { release = resolve; }),
            body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } });
        if (!account) throw new Error('Expected captured Account');
        vi.useFakeTimers();
        let settled = false;
        const pending = executeOriginalAccountActionTransport({ account, binding,
            input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' })
            .finally(() => { settled = true; });
        await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(readSpawnSessionRpcTimeoutMsFromEnv() + 1);
        expect(settled).toBe(false);
        release();
        await expect(pending).resolves.toEqual({ ok: true, result: { completed: true } });
    });

    it('preserves the typed daemon refusal while keeping the effect outcome uncertain', async () => {
        const diagnostic = { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' };
        homes.answer(serverId, path, { status: 502, body: { error: 'invalid_request', code: 'action_outcome_unknown',
            requestId: binding.requestId, diagnostic } });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', details: { diagnostic } });
    });

    it('keeps the server’s empty post-dispatch 502 acknowledgement loss uncertain', async () => {
        // An older loaded Home sends this exact empty response after its daemon
        // dispatcher reports submitted_unknown, without a retry.
        homes.answer(serverId, path, { status: 502 });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    });

    it('keeps an issued Action uncertain when its HTTP observer loses the response', async () => {
        homes.answer(serverId, path, { dispatchThenFail: true });
        const result = await execute();
        expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
            failureCause: { phase: 'external_action.http.execute', errorClass: 'TypeError', errorCode: null, httpStatus: null } });
        expect(readActionOutputDiagnostic(result)).toMatchObject({
            exception: { errorClass: 'TypeError', message: expect.any(String) },
        });
        expect(JSON.stringify(result)).not.toContain('Failed to fetch');
    });

    it('retains the response body read failure after an Action was issued', async () => {
        let rejectBody!: (error: unknown) => void;
        const bodyAfter = new Promise<void>((_resolve, reject) => { rejectBody = reject; });
        homes.answer(serverId, path, { bodyAfter,
            body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } });
        const pending = execute();
        await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
        rejectBody(new TypeError('Failed to read Action response'));
        const result = await pending;
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output',
            failureCause: { phase: 'external_action.http.response', errorClass: 'TypeError', errorCode: null, httpStatus: null } });
        expect(readActionOutputDiagnostic(result)).toMatchObject({
            exception: { errorClass: 'TypeError', message: expect.any(String) },
        });
        expect(JSON.stringify(result)).not.toContain('Failed to read Action response');
    });

    it('retains canonical uncertainty when an issued write exhausts its caller-owned budget', async () => {
        let release!: () => void;
        homes.answer(serverId, path, { respondAfter: new Promise<void>(resolve => { release = resolve; }),
            body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } });
        if (!account) throw new Error('Expected captured Account');
        vi.useFakeTimers();
        const timeoutMs = readSpawnSessionRpcTimeoutMsFromEnv();
        const pending = executeOriginalAccountActionTransport({ account, binding,
            input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user', timeoutMs });
        try {
            await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
            await vi.advanceTimersByTimeAsync(timeoutMs + 1);
            await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            expect(homes.requestsFor(path)).toHaveLength(1);
        } finally { release(); }
    });

    it.each([
        { status: 200 },
        { status: 502, body: { notAnActionResponse: true } },
    ])('does not reinterpret another malformed response as known acknowledgement loss (%j)', async answer => {
        homes.answer(serverId, path, answer);
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it.each(['invalid_envelope', 'project_requester_home_unavailable'] as const)('preserves a schema-valid pre-dispatch refusal (%s) instead of making it uncertain', async code => {
        const refusal = projectExternalActionHttpError(code, binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: code });
    });
});


it.each([{ code: 'target_not_local', stage: 'effect' }, { code: 'credential_scope_denied', stage: 'effect' },
    { code: 'target_not_local', stage: 'mint' }, { code: 'credential_scope_denied', stage: 'mint' }] as const)('keeps closed cause, phase and request correlation for $code at $stage', async ({ code, stage }) => {
    const failureCause = { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: 403 } as const;
    const refusal = code === 'credential_scope_denied'
        ? projectExternalActionHttpError(code, binding.requestId, undefined, { admissionStage: 'daemon_rpc', errorCode: 'RPC_FORBIDDEN', failureCause })
        : projectExternalActionHttpError(code, binding.requestId, undefined, undefined, 'target_installation', undefined, failureCause);
    homes.answer(serverId, stage === 'mint' ? `${path}/execution-authorization` : path, { status: refusal.statusCode, body: refusal.payload });
    if (!account) throw new Error('Expected captured Account');
    const result = stage === 'mint' ? await executeOriginalAccountActionTransport({ account, binding, input: {}, authority: 'present_user',
        machineCustody: { accountMode: 'plain', installationId: 'installation-1', custodian: { accountId: 'foreign-owner' },
            installationPublicKey: nacl.box.keyPair().publicKey } }) : await execute();
    expect(result).toMatchObject({ ok: false, errorCode: code, requestId: binding.requestId, failureCause,
        ...(code === 'target_not_local' ? { details: { phase: 'target_installation' } } : {}) });
});

it('keeps an outer-only V1 execution failure correlation after matching the response', async () => {
    homes.answer(serverId, path, { body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
        execution: { ok: false, errorCode: 'target_not_local', error: 'target_not_local' } } });
    expect(await execute()).toMatchObject({ ok: false, requestId: binding.requestId, errorCode: 'target_not_local' });
});


it.each([true, false])('keeps closed cause but binds encrypted diagnostic adoption to the issued request (%s)', async correlated => {
    if (!account) throw new Error('Expected captured Account');
    const diagnostic = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    homes.answer(serverId, path, { status: 409, body: { error: 'invalid_request', code: 'target_unavailable', diagnostic,
        ...(correlated ? { requestId: binding.requestId } : {}) } });
    const result = await executeOriginalAccountActionTransport({ account, binding, input: {},
        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(13) } });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    if (correlated) expect(result).toMatchObject({ details: diagnostic });
    else expect(result).not.toHaveProperty('details');
});
