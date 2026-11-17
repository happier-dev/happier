import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { ExternalActionSignedAuthenticationV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionAccountServerPrincipalV1Schema, ExternalActionTerminalServerPrincipalV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { executeExternalAction } from '../externalActions/executeExternalAction';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { logger } from '@/ui/logger';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionContext';

// The Home HTTP and physical process/listener are system boundaries. The installed
// ingress, private Account admission, bootstrap and Session Action owners stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
    { authenticationKind: 'account', scenario: 'session start' },
    { authenticationKind: 'terminal', scenario: 'session start' },
    { authenticationKind: 'account', scenario: 'retained startup' },
    { authenticationKind: 'terminal', scenario: 'retained startup' },
] as const)('admits $authenticationKind custody through real daemon ingress for $scenario', async ({ authenticationKind, scenario }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-r35-requester-birth-'));
    const homeId = 'srv_requester_birth';
    const endpoint = 'https://requester-birth.test';
    const authority = authenticationKind === 'terminal' ? 'account_automation' : 'present_user';
    const requesterToken = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 0,
        ...(authenticationKind === 'terminal' ? { session: 'bob-terminal-session' } : {}),
        provenance: { v: 1, kind: authenticationKind, authority } })).toString('base64url')}.signature`;
    const custodianToken = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    let admissionCurrent = true;
    const phaseDiagnostics = vi.spyOn(logger, 'warnLocalFile');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return Response.json({ id: 'bob' });
        throw new Error(`Unexpected Home fetch: ${path}`);
    }));
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
        if (url.includes('/v2/sessions')) return { status: 200, data: { sessions: [], hasNext: false } };
        throw new Error(`Unexpected Home read: ${new URL(url).pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
        if (url.endsWith('/execution-authorization/verify')) return { status: admissionCurrent ? 200 : 401, data: { ok: admissionCurrent } };
        if (url.endsWith('/v2/sessions/query')) return { status: 200, data: { sessions: [], hasNext: false } };
        if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
        throw new Error(`Unexpected Home write: ${new URL(url).pathname}`);
    });
    let received: AdmittedRequesterSessionBootstrap | undefined;
    let physicalLaunches = 0;
    const lifecycle = createSpawnNewSessionLifecycleActionHandler({ serverId: homeId, spawnSession: async options => {
        physicalLaunches += 1;
        received = options.requesterSessionBootstrap;
        expect(await received?.isCurrent()).toBe(true);
        return { type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Physical child intentionally unavailable' };
    } });
    const transport = createMachineSessionDirectTargetTransport({ machineId: 'machine', spawnLifecycleHandler: lifecycle });
    const fixture = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: join(directory, 'daemon'),
        activeServerDir: join(directory, 'daemon', 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
        machineId: 'machine', custodianAccountId: 'alice', credentials: { token: custodianToken, encryption: null },
        connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
        trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        startup: { resolveSessionSpawnDirectTargetTransport: () => transport,
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }) } });
    let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
    try {
        currentnessChannel = await createRequesterCurrentnessSocketHarness();
        const installation = fixture.installation;
        const ingress = fixture.runtime.externalActionIngressOwner;
        if (!installation || !ingress?.prepareRequesterAccountContext) throw new Error('Missing actual daemon ingress');
        const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: homeId, machineId: 'machine' },
            directory: { kind: 'path', path: directory }, creationKey: SessionCreationKeyV1Schema.parse('manual:requester-birth'),
            connectedServices: { v: 1, bindingsByServiceId: {} },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
        const admittedInput = getActionSpec('session.spawn_new').inputSchema.safeParse(input);
        expect(admittedInput, JSON.stringify(admittedInput)).toMatchObject({ success: true });
        const target = { kind: 'machine' as const, machineId: 'machine' };
        // The HTTP boundary serializes optional Action fields before ingress.
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(JSON.stringify({
            v: 1, requestId: 'requester-birth', target, input,
        })));
        const acceptedEnvelope = ExternalActionRequestEnvelopeSchema.safeParse(envelope);
        expect(acceptedEnvelope, JSON.stringify(acceptedEnvelope)).toMatchObject({ success: true });
        const authentication = ExternalActionSignedAuthenticationV1Schema.parse({ kind: authenticationKind, tokenEpoch: 0 });
        const principal = (authenticationKind === 'terminal' ? ExternalActionTerminalServerPrincipalV1Schema
            : ExternalActionAccountServerPrincipalV1Schema).parse({ accountId: 'bob', authentication, authority });
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: 'bob', custodianAccountId: 'alice', authentication, accountEncryptionMode: 'plain',
            machineId: 'machine', installationId: installation.installationId, serverIdentityId: homeId,
            actionId: 'session.spawn_new', requestId: 'requester-birth', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            target,
        } });
        const boxed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
            installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), credentials: { token: requesterToken },
            randomBytes: length => new Uint8Array(randomBytes(length)) });
        if (scenario === 'retained startup') {
            // READY152 admitted this request before startup published apiMachineForSessions.
            // The fixture has the same null getter; transport publication is not custody retirement.
            const prepared = await ingress.prepareRequesterAccountContext({ authorization: boxed,
                purpose: { kind: 'external_action' } });
            if (!prepared) throw new Error('Missing admitted requester context');
            const operation = new AbortController();
            let releaseRetained: (() => Promise<void>) | undefined;
            try {
                const requester = readRequesterAccountActionContext(prepared.authorization);
                if (!requester?.retainForOperation) throw new Error('Missing real requester operation owner');
                const retained = await requester.retainForOperation(operation.signal);
                releaseRetained = retained.dispose;
                await prepared.dispose();
                const retainedRequester = readRequesterAccountActionContext(retained.authorization);
                expect(await retainedRequester?.isCurrent()).toBe(true);
                operation.abort();
                expect(await retainedRequester?.isCurrent()).toBe(false);
                const active = await requester.retainForOperation(new AbortController().signal);
                try {
                    const activeRequester = readRequesterAccountActionContext(active.authorization);
                    expect(await activeRequester?.isCurrent()).toBe(true);
                    await fixture.runtime.stopControlServer();
                    expect(await activeRequester?.isCurrent()).toBe(false);
                } finally { await active.dispose(); }
            } finally {
                await releaseRetained?.();
                await prepared.dispose();
            }
            return;
        }
        const invoke = (surface?: 'ui') => executeExternalAction({ actionId: 'session.spawn_new', envelope,
            ...(surface ? { surface } : {}),
            principal,
            currentMachineId: 'machine', currentServerId: homeId, currentServerHttpBaseUrl: endpoint,
            currentInstallationId: installation.installationId, executionAuthorization: boxed,
            externalActionMachineRequestPrivateKey: decodeBase64(installation.privateKey, 'base64url'),
            verifyExecutionAuthorization: async () => admissionCurrent,
            prepareRequesterAccountContext: ingress.prepareRequesterAccountContext,
            resolveTarget: ingress.resolveTarget, resolveEncryption: ingress.resolveEncryption, executor: ingress.executor,
        });
        const outcome = await invoke();
        const refusedPhases = phaseDiagnostics.mock.calls.filter(([message]) => message === '[external-action-phase]')
            .map(([, diagnostic]) => diagnostic);
        expect(physicalLaunches, JSON.stringify({ outcome, refusedPhases })).toBe(1);
        expect(received, JSON.stringify(outcome)).toBeDefined();
        expect(received?.attribution).toEqual({ serverId: homeId, accountId: 'bob', machineId: 'machine', installationId: installation.installationId });
        expect(received?.credentials.token).toBe(requesterToken);
        expect(received?.savedSecretOperationContext.machineAdmission).toEqual({ actorAccountId: 'bob', custodianAccountId: 'alice' });
        expect(await received?.isCurrent()).toBe(false);
        if (authenticationKind === 'terminal') {
            const explicitUi = await invoke('ui');
            expect(explicitUi).toMatchObject({ kind: 'response', response: { execution: { ok: false } } });
            expect(physicalLaunches).toBe(1);
        }
        admissionCurrent = false;
        expect(await received?.isCurrent()).toBe(false);
    } finally {
        try { await fixture.dispose(); }
        finally {
            try { await currentnessChannel?.close(); }
            finally { await rm(directory, { recursive: true, force: true }); }
        }
    }
});
