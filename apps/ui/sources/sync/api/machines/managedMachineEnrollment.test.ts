import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineFullV1Schema, ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedAcquireInputV1Schema, ManagedEnrollmentFullCorrelationV1Schema,
    projectManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { runUiManagedMachineEnrollment } from './managedMachineEnrollment';

installApprovalCommonModuleMocks();
afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('app managed enrollment', () => {
    it.each([
        { mode: 'plain', review: 'matching', snapshot: 'full' }, { mode: 'e2ee', review: 'matching', snapshot: 'full' },
        { mode: 'plain', review: 'forged', snapshot: 'full' },
        { mode: 'plain', review: 'mismatched', snapshot: 'full' },
        { mode: 'e2ee', review: 'matching', snapshot: 'opaque' },
    ] as const)('uses ordinary $mode Account pairing for the $snapshot snapshot only under the $review creation review', async ({ mode, review, snapshot }) => {
        const homeId = `srv_app_native_${mode}`;
        const serverUrl = `https://app-native-${mode}.example.test`;
        const lifetime = new AbortController();
        onTestFinished(() => lifetime.abort());
        const browser = await installBrowserRuntimeForTests({ url: serverUrl });
        onTestFinished(() => browser.restore());
        const profile = await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        const token = createAccountTokenForTests('creator', { currentAccount: true });
        const credentials: AuthCredentials = mode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(19), 'base64url') };
        const descriptor = { v: 1 as const, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        const target = { ...resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' }),
            profileId: profile.id, authority: 'saved_profile' as const };
        const launch = { provider: { pluginId: 'test.compute', localId: 'sandbox' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const machine = ManagedMachineFullV1Schema.parse({ id: 'paid-resource', homeId, custodianAccountId: 'creator', launch,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'retained' } } });
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: machine.enrollmentIdentity,
            selection: { kind: 'one-off', homeId, launch, retention: machine.retention, wakeOnAcceptedMessage: true } });
        const correlation = ManagedEnrollmentFullCorrelationV1Schema.parse({ homeId, managedId: machine.id,
            requestId: 'create', expectedIntentRevision: 1, resource: machine.resource });
        const { launch: _launch, resource: _resource, enrollmentIdentity: _identity, ...structural } = machine;
        const originalMachine = snapshot === 'opaque' ? ManagedMachineV1Schema.parse({ ...structural,
            preset: { id: 'private-preset', revision: 2, contentEncryptionMode: 'e2ee' } }) : machine;
        const homeCorrelation = projectManagedEnrollmentCorrelationV1(originalMachine, correlation);
        const pairing = { secretB64Url: encodeBase64(new Uint8Array(32).fill(23), 'base64url'),
            createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };
        const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
            publicKey: encodeBase64(new Uint8Array(32).fill(1)), homeServerIdentityId: homeId,
            pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' };
        const completion = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
            homeServerIdentityId: homeId, machineId: 'joined', encryptionType: mode === 'plain' ? 'tokenOnly' : 'dataKey',
            pairingAuthentication: 'v3', remoteProfileId: 'guest-home' };
        const approvalKinds: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            expect(new URL(String(url)).origin).toBe(serverUrl);
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId: homeId } },
            }));
            if (path === '/v1/auth/request/status') return Response.json({ status: 'pending', supportsV2: true });
            if (path === '/v1/auth/response') {
                const response = JSON.parse(String(init?.body)) as { responseKind: unknown };
                approvalKinds.push(response.responseKind);
                return Response.json({ success: true });
            }
            throw new Error(`Unexpected Home path: ${path}`);
        });
        const { Modal } = await import('@/modal');
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        let running = false;
        let rowReads = 0;
        const progress: unknown[] = [];
        const prompts: unknown[] = [];
        const installationResources: unknown[] = [];
        let guestEnrollment: unknown;
        let recipeEntered = false;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            managedMachineAction: async call => {
                recipeEntered = true;
                const enrolled = await runUiManagedMachineEnrollment({
                    correlation, homeCorrelation,
                    target, carrier: { kind: 'native', transport: { contributionRef: launch.provider, schemaVersion: 1 } },
                    channel: 'stable', signal: lifetime.signal, credentials,
                    reviewedAction: review === 'mismatched'
                        ? ManagedAcquireInputV1Schema.parse({ ...input, selection: {
                            ...input.selection, launch: { ...launch, name: 'Another Guest' },
                        } })
                        : input,
                    context: review === 'forged' ? { ...call.context, hostReviewedChild: {
                        parent: call.context.hostReviewedChild?.parent,
                        invoke: async () => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }),
                    } } : call.context,
                    onProgress: event => progress.push(event), onPrompt: prompt => prompts.push(prompt),
                }, {
                    readCurrentManagedRow: async () => { rowReads++; return machine; },
                    // Source-payload transfer is a host IO strategy, replacing only external guest installation bytes.
                    installNativePayload: async installation => {
                        installationResources.push(installation.resource);
                        return { binaryPath: '/home/guest/.happier/cli/current/happier' };
                    },
                    native: { putFile: async () => {}, exec: async ({ command, input }) => {
                        if (command.startsWith('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' };
                        if (command.includes("'auth' 'request'")) {
                            const guestInput: unknown = JSON.parse(input ?? 'null');
                            if (guestInput && typeof guestInput === 'object' && 'managedEnrollment' in guestInput) {
                                guestEnrollment = guestInput.managedEnrollment;
                            }
                            return { status: 0, stdout: JSON.stringify(request), stderr: '' };
                        }
                        if (command.includes("'auth' 'wait'")) return { status: 0, stdout: JSON.stringify(completion), stderr: '' };
                        if (command.includes("'daemon' 'start'")) running = true;
                        const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined',
                            services: [], service: { installed: false }, daemon: { running, healthy: running }, auth: { needsAuth: false, machineId: 'joined' },
                            server: { activeServerId: 'guest-home' } };
                        return { status: 0, stdout: JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status }), stderr: '' };
                    } },
                });
                expect(enrolled.machineId).toBe('joined');
                return { managedId: machine.id };
            },
        }));
        const context = bindPresentUserActionConfirmation('machines.managed.acquire', input,
            { surface: 'ui', authority: 'present_user', runtimeAccountId: 'creator', serverIdentityId: homeId, actionRequestId: 'create',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
        const result = await executor.execute('machines.managed.acquire', input, context);
        expect(recipeEntered).toBe(true);
        if (review === 'mismatched' || review === 'forged') {
            expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            expect(rowReads).toBe(0);
            expect(approvalKinds).toEqual([]);
            expect(confirm).not.toHaveBeenCalled();
            expect(running).toBe(false);
            return;
        }
        expect(result.ok ? undefined : result.errorCode).toBeUndefined();
        expect(result).toMatchObject({ ok: true, result: { managedId: machine.id } });
        expect(running).toBe(true);
        expect(rowReads).toBe(1);
        expect(approvalKinds).toEqual([mode === 'plain' ? 'tokenOnly' : 'dataKey']);
        expect(installationResources).toEqual([correlation.resource.value]);
        expect(guestEnrollment).toEqual(homeCorrelation);
        if (snapshot === 'opaque') expect(guestEnrollment).not.toHaveProperty('resource');
        else expect(guestEnrollment).toHaveProperty('resource', correlation.resource);
        expect(confirm).not.toHaveBeenCalled();
        expect(JSON.stringify([progress, prompts])).not.toContain(pairing.secretB64Url);
    });
});
