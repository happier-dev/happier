import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createActionExecutor, type ActionExecutorContext, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { dispatchLocalManagedMachineAgentIsolation } from './externalActionExecutionAuthorization';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId, updateSettings } from '@/persistence';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

afterEach(() => vi.restoreAllMocks());

it.each([
    { scenario: 'declared', mode: 'plain' }, { scenario: 'undeclared', mode: 'plain' },
    { scenario: 'other Machine', mode: 'plain' }, { scenario: 'other requester', mode: 'plain' },
    { scenario: 'other confirmation Machine', mode: 'plain' }, { scenario: 'other confirmation requester', mode: 'plain' },
    { scenario: 'other request', mode: 'plain' }, { scenario: 'declared', mode: 'e2ee' }, { scenario: 'undeclared', mode: 'e2ee' },
] as const)('carries the reviewed Create isolation child through original Account admission ($mode $scenario)', async ({ scenario, mode }) => {
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    const lifetime = new AbortController();
    onTestFinished(() => lifetime.abort());
    const profile = `managed-child-review-${randomUUID()}`;
    onTestFinished(() => removeStoredCredentialsForServerId(profile));
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [profile]: {
        id: profile, name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.example' }] },
    } } }));
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 2,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const secret = new Uint8Array(32).fill(23);
    await writeStoredCredentialsForServerId(profile, { token, encryption: mode === 'plain' ? null : { type: 'legacy', secret } });
    const credentials = await readStoredCredentialsForServerId(profile);
    if (!credentials) throw new Error('Missing fixture credentials');
    const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    // Own E2EE dispatch pins the installation key from authenticated Machine content.
    const metadata = mode === 'e2ee' ? createMachineContentCodec({ encryptionMode: 'e2ee',
        encryptionKey: secret, encryptionVariant: 'legacy' }).encodeStored(MachinePublishedMetadataV1Schema.parse({
        host: 'guest', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier',
        installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64url'),
    })) : null;
    const childAction = 'machines.agentIsolation.set';
    const target = { kind: 'machine' as const, machineId: scenario === 'other Machine' ? 'other' : 'guest' };
    const childInput = { serverId: 'srv_home', machineId: target.machineId, enabled: true, memberProvisioning: 'linuxUsersV1' as const,
        expectedMetadataVersion: 0, expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-plan' };
    const parentInput = ManagedAcquireInputV1Schema.parse({
        enrollmentIdentity: scenario === 'undeclared' ? { kind: 'existingUser', role: 'adopted' }
            : { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
        selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'controller-installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, ...(scenario === 'undeclared' ? { actions: {
        [childAction]: { approvalRequiredSurfaces: ['cli'] },
    } } : {}) });
    const asks: string[] = [];
    const askSurfaces: unknown[] = [];
    let effects = 0;
    let childResult: ActionExecuteResult | undefined;
    let storedApproval: ReturnType<typeof StoredApprovalRequestSchema.parse> | null = null;
    const guestHarness = createCliActionExecutorHarness({ token, credentials,
        ...(mode === 'plain' ? { mode: 'plain' as const, ctx: null }
            : { mode: 'e2ee' as const, ctx: { encryptionVariant: 'legacy' as const, encryptionKey: secret } }),
        sessionId: '', serverId: profile, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
        actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => null },
    }, {
        // Artifact storage and native effects are boundaries; policy and the
        // private requester/child admission run through their real owners.
        approvalsCreate: async ({ request }) => {
            asks.push(request.actionId); askSurfaces.push(request.requestedSurface);
            // The remote person declines at the Artifact boundary; observation and
            // propagation use the real host owner rather than a synthetic observer.
            storedApproval = StoredApprovalRequestSchema.parse({ ...request, status: 'rejected',
                updatedAtMs: request.updatedAtMs + 1, decision: { kind: 'reject', decidedAtMs: request.updatedAtMs + 1 } });
            expect(decideApprovalRequestTransition(request, storedApproval)).toMatchObject({ ok: true });
            return { artifactId: 'isolation-ask' };
        },
        approvalsGet: async () => storedApproval,
        machineAgentIsolationAction: async () => { effects++; return { kind: 'accepted', operationId: 'isolation', metadataVersion: 1,
            status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }; },
    });
    const guest = guestHarness.executor;
    // The real Account Automation selector reads its index through this HTTP boundary.
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        expect(config.url).toBe(`https://home.example${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`);
        expect(config.method).toBe('GET');
        expect(config.headers).toMatchObject({ Authorization: `Bearer ${token}` });
        return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode, version: 1,
            settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
        const machineId = url.endsWith('/v1/machines/controller') ? 'controller' : target.machineId;
        const machine = { id: machineId, kind: 'persistent', active: true, installationId: machineId === 'controller' ? 'controller-installation' : 'guest-installation',
            installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64'), revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            metadata, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: mode, accessState: 'ready' } };
        return { status: 200, data: url.includes('/v1/machines/') ? { machine } : [{ ...machine, metadata: undefined }] };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
        if (url.endsWith('/execution-authorization')) {
            // Home is the network trust boundary. It binds the enrolled guest,
            // requester and request; it refuses a different Machine.
            if (scenario === 'other Machine') return { status: 403, data: { error: 'permission_denied' } };
            return { status: 200, data: { v: 1, token: 'home-proof', binding: {
                accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'terminal', tokenEpoch: 2 },
                accountEncryptionMode: mode, serverIdentityId: 'srv_home', machineId: target.machineId,
                installationId: 'guest-installation', actionId: childAction, requestId: 'creation', target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
                managedContinuation: { ...body.managedContinuation, controller: parentInput.selection.kind === 'one-off'
                    ? parentInput.selection.controller : {}, acquireRequestEnvelopeDigest: 'a'.repeat(43) },
            } } };
        }
        expect(url).toBe(`https://home.example/v1/actions/${childAction}`);
        const result = await executeExternalAction({ actionId: childAction, envelope: body.envelope,
            executionAuthorization: body.executionAuthorization, principal: { accountId: 'account', authority: 'account_automation',
                authentication: { kind: 'terminal', tokenEpoch: 2 } }, currentMachineId: target.machineId,
            currentAccountId: 'account', currentServerId: profile, currentServerHttpBaseUrl: 'https://home.example',
            currentInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: keyPair.secretKey,
            verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: guest,
            prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
                purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'guest-installation',
                installationPrivateKey: keyPair.secretKey, serverId: profile, serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => guest }),
        });
        if (result.kind !== 'response') throw new Error(`Child ingress refused: ${result.errorCode}`);
        return { status: 200, data: result.prepared.response };
    });
    const parent = createActionExecutor({ ...createUnavailableActionTransportDeps(), managedMachineAction: async ({ context }) => {
        const result = await dispatchLocalManagedMachineAgentIsolation({ actionId: childAction, input: childInput,
            homeId: 'srv_home', managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0 },
            context, credentials, custodianAccountId: scenario === 'other requester' ? 'other-account' : 'account',
            serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
            observeRecordedApprovalExecution: guestHarness.observeRecordedApprovalExecution });
        childResult = result;
        return result.ok ? { managedId: 'managed' } : result;
    } });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, signal: lifetime.signal,
        runtimeAccountId: 'account', serverId: 'srv_home', serverIdentityId: 'srv_home', actionRequestId: 'creation', actionsSettings: settings,
        externalActionTarget: { kind: 'machine', machineId: 'controller' },
        presentUserConfirmation: { actionId: 'machines.managed.acquire',
            accountId: scenario === 'other confirmation requester' ? 'other-account' : 'account', serverId: 'srv_home',
            requestId: scenario === 'other request' ? 'other-request' : 'creation',
            target: { kind: 'machine', machineId: scenario === 'other confirmation Machine' ? 'other-controller' : 'controller' },
            inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', parentInput) } };
    const result = await parent.execute('machines.managed.acquire', parentInput, context);
    if (scenario === 'other confirmation Machine' || scenario === 'other confirmation requester' || scenario === 'other request') {
        expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        expect(childResult).toBeUndefined(); expect(asks).toEqual([]); expect(effects).toBe(0);
    } else if (scenario === 'declared') {
        expect(result, result.ok ? undefined : JSON.stringify({ result, childResult, asks, effects })).toMatchObject({ ok: true });
        expect(childResult).toMatchObject({ ok: true, result: { kind: 'accepted', operationId: 'isolation' } });
        expect(asks).toEqual([]); expect(effects).toBe(1);
    } else if (scenario === 'undeclared') {
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(childResult).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(asks).toEqual([childAction]); expect(effects).toBe(0);
        // An undeclared child has no reviewed invocation box, so its authenticated
        // terminal chooses the policy surface rather than the parent's UI stamp.
        expect(askSurfaces).toEqual(['cli']);
    } else {
        expect(result).toMatchObject({ ok: false }); expect(asks).toEqual([]); expect(effects).toBe(0);
    }
});
