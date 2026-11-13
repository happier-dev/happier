import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRuntimeFetchHost, resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { standardCleanup } from '@/dev/testkit';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { Modal } from '@/modal';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { log } from '@/log';

const vendorHttp = vi.hoisted(() => vi.fn<typeof fetch>());
const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vendorHttp }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Only packaged inventory and asset IO are replaced; compilation, public
// activation, selected-purpose resolution and authentication stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `file:///managed-power-fixture/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads++;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged power fixture');
        return bytes;
    }
} }));

installApprovalCommonModuleMocks();
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
const { prepareAuthenticationInventory } = await import('@/dev/testkit/fixtures/connectedAccountAuthentication');
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/manifest.ts',
    additionalArtifacts: [{ target: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        entryPath: 'packages/plugins/machine-vercel/src/account.ts' }],
    packageName: '@happier-dev/plugins-machine-vercel' });
afterEach(async () => {
    await (await import('@/components/plugins/reactNative/clientExecutableContributions'))
        .getInstalledPluginUiClientExecutableComposition().unload();
    await standardCleanup();
});

describe('Account native power through the original reviewed role port', () => {
    it.each(['confirmed', 'refused', 'unknown', 'inspect-unavailable', 'after-idle', 'delayed'] as const)('uses one admitted retained intent, outcome=%s', async outcome => {
        const refused = outcome === 'refused';
        const homeId = `srv_native_power_${outcome}`;
        const serverUrl = `https://native-power-${outcome}.example.test`;
        const accountId = 'owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
        const provisioner = manifest.contributes.machineProvisioners[0]!;
        const provider = { pluginId: manifest.id, localId: provisioner.id };
        const selectedAccount = { service: { pluginId: provider.pluginId, localId: 'vercel-account' }, accountId: 'selected' };
        const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
            purpose: { consumer: provider, purpose: 'cloud-api' }, account: selectedAccount,
        }] };
        let machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: accountId,
            launch, allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        });
        const input = outcome === 'after-idle'
            ? { homeId, managedId: machine.id, when: 'after-idle' as const, intent: 'stop' as const }
            : { homeId, managedId: machine.id, expectedRevision: machine.intentRevision, when: 'now' as const, intent: 'start' as const };
        const paths: string[] = [];
        const native: string[] = [];
        let inspections = 0;
        // Home HTTP and the provider role effect are system boundaries. Parsing,
        // retained control and reviewed-child custody use their real owners.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            // A foreign public row read is refused; power authority comes from
            // the canonical admission, which must return managed_power_required.
            if (path.endsWith('/actions/get')) return refused
                ? Response.json({ code: 'permission_denied' }, { status: 403 })
                : Response.json({ ...machine, resource: { ...machine.resource, value: { id: 'stale-before-admission' } } });
            if (path.endsWith('/admit-control')) {
                if (refused) return Response.json({ code: 'managed_power_required' }, { status: 403 });
                machine = { ...machine, desired: input.intent, desiredWhen: input.when, intentRevision: 3 };
                return Response.json({ machine, replayed: false });
            }
            if (path.endsWith('/submit-intent')) return Response.json({ machine, submitted: true });
            if (path.endsWith('/report-intent')) {
                const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
                expect(body).toMatchObject({ expectedIntentRevision: 3, requestId: 'original-power',
                    result: { kind: outcome === 'unknown' ? 'unknown' : 'confirmed' } });
                if (outcome === 'delayed') expect(body).toMatchObject({ observation: {
                    observedAt: 30, availability: 'present', power: 'running', storage: 'retained',
                } });
                if (outcome === 'inspect-unavailable') expect(body).not.toHaveProperty('observation');
                else machine = { ...machine, observation: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } };
                return Response.json({ machine });
            }
            throw new Error(`Unexpected HTTP path ${path}`);
        });
        onTestFinished(resetRuntimeFetch);
        const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionRequestId: 'original-power',
            runtimeAccountId: accountId, operationAcceptance: { operationId: 'original-operation', accept() {} }, operationOwnerUpdate: { update() {} } };
        context.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input, context,
            reviewAdmitted: true, plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role })) },
            execute: async (body, _context, actionId) => {
                expect(actionId).toBe('action.invoke');
                if (!body || typeof body !== 'object' || !('action' in body)) throw new Error('Expected provider role envelope');
                const action = body.action;
                if (!action || typeof action !== 'object' || !('localId' in action) || typeof action.localId !== 'string') {
                    throw new Error('Expected native Action identity');
                }
                const role = action.localId;
                expect(_context.invocationServices?.managedMachine).toEqual(machine);
                expect(_context.invocationServices?.connectedAccountPurposeBinding).toMatchObject({
                    identity: { pluginId: provider.pluginId, localId: role },
                    purposeBindings: { v: 1, bindings: [{ purpose: { consumer: { pluginId: provider.pluginId, localId: role },
                        purpose: 'cloud-api' }, target: { kind: 'account', account: selectedAccount } }] },
                });
                expect(['power', 'inspect']).toContain(role);
                expect(body).toMatchObject({ input: { resource: { id: 'same-native' } } });
                native.push(role);
                if (role === 'inspect') {
                    inspections++;
                    if (outcome === 'inspect-unavailable' && inspections > 1) {
                        return { ok: false, errorCode: 'provider_unavailable', error: 'provider_unavailable' };
                    }
                    return { ok: true, result: { observedAt: outcome === 'delayed' ? inspections * 10 : inspections,
                        availability: 'present', power: inspections < (outcome === 'delayed' ? 3 : 2) ? 'stopped' : 'running',
                        storage: 'retained' } };
                }
                return { ok: true, result: outcome === 'unknown'
                    ? { kind: 'unknown', code: 'action_outcome_unknown' } : { kind: 'confirmed' } };
            } });
        const account = await captureLazyActionAccountContext(homeId);
        expect(account).not.toBeNull();
        if (!account) throw new Error('Expected Account');
        onTestFinished(() => account.dispose());
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.power.set', input, context });
        if (refused) {
            expect(result).toMatchObject({ ok: false, errorCode: 'managed_power_required' });
            expect(native).toEqual([]);
        } else if (outcome === 'unknown' || outcome === 'inspect-unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect(native).toEqual(['inspect', 'power', 'inspect']);
        } else if (outcome === 'after-idle') {
            expect(result).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
            expect(machine.desiredWhen).toBe('after-idle');
            expect(native).toEqual([]);
            expect(paths.some(path => path.endsWith('/submit-intent') || path.endsWith('/report-intent'))).toBe(false);
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
            expect(native).toEqual(outcome === 'delayed' ? ['inspect', 'power', 'inspect', 'inspect'] : ['inspect', 'power', 'inspect']);
            if (outcome === 'delayed') expect(paths.filter(path => path.endsWith('/report-intent'))).toHaveLength(1);
        }
        expect(paths.filter(path => path.endsWith('/admit-control'))).toHaveLength(1);
        expect(paths.some(path => path.endsWith('/execution-authorization'))).toBe(false);
    });
});

it.each(['confirmed', 'admission-refused', 'guest-startup-report-failed', 'native-refused-report-failed', 'confirmed-report-failed', 'native-refused-report-confirmed', 'resize-unsupported-report-failed'] as const)(
    'settles retained Account power through public activation and its selected credential, outcome=%s', async outcome => {
    const refused = outcome === 'admission-refused';
    const guestStartup = outcome === 'guest-startup-report-failed';
    const nativeRefused = outcome.startsWith('native-refused-');
    const reportFailed = outcome.endsWith('report-failed');
    const resizeUnsupported = outcome === 'resize-unsupported-report-failed';
    const actionId = resizeUnsupported ? 'machines.managed.resize' : 'machines.managed.power.set';
    const logStart = log.getCount();
    // Native HTTP is the intended runtime boundary; a browser requires a selected remote host.
    // The real credential owner verifies writes through the desktop OS storage command boundary.
    vi.stubGlobal('__TAURI_INTERNALS__', { ...createDesktopSecureStorageBoundary(),
        metadata: { currentWindow: { label: 'main' } } });
    expect(await readRuntimeFetchHost('https://foreground-native-power.test')).toBe('native');
    const homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    onTestFinished(() => homes.reset());
    const accountId = 'foreground-power-owner';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverUrl = 'https://foreground-native-power.test';
    const homeId = 'srv_foreground_native_power';
    const serverId = await homes.addHome({ name: 'Power', serverUrl, accountId, credentials, serverIdentityId: homeId,
        accountEncryptionMode: 'plain', credentialResourcesEnabled: true });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const provisioner = PLUGIN_MANIFEST.contributes.machineProvisioners![0]!;
    const provider = { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id };
    const selected = { service: { pluginId: provider.pluginId, localId: 'vercel-account' }, accountId: 'selected-power-token' };
    const secret = 'private-selected-power-token';
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
        purpose: { consumer: provider, purpose: 'cloud-api' }, account: selected,
    }] };
    let machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: refused ? 'another-owner' : accountId,
        launch, allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
        ...(guestStartup ? { enrolledMachineId: 'enrolled-guest', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } } : {}),
        resource: { contributionRef: provider, schemaVersion: 1,
            value: { name: 'same-native', createdAt: 1000, managedId: 'retained', teamId: 'team_one', projectId: 'prj_one' } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    });
    let credential: unknown;
    let configuration: unknown;
    let admissions = 0;
    let submitted = 0;
    let reports = 0;
    let nativeResumes = 0;
    let guestBoots = 0;
    const roles: string[] = [];
    const reported: unknown[] = [];
    const requests: string[] = [];
    onTestFailed(() => { console.info('Managed power boundary evidence', JSON.stringify({
        roles, requests, reported, admissions, submitted, reports, nativeResumes, guestBoots,
    })); });
    const connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials,
        additionalRequestOrigins: ['https://api.vercel.com'],
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (url, init) => {
            const address = new URL(String(url));
            requests.push(address.pathname);
            if (address.origin === 'https://api.vercel.com') return vendorHttp(url, init);
            if (address.pathname === '/v4/connect/qualified/accounts') return Response.json({ service: selected.service,
                accounts: [{ ref: selected, status: 'connected', authenticationModeId: 'token', configurationReady: true,
                    configurationRevision: 'selected-config', revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
            if (address.pathname === '/v4/connect/qualified/credential') return Response.json(credential);
            if (address.pathname === '/v4/connect/qualified/configuration') return Response.json(configuration);
            if (address.pathname.endsWith('/actions/get')) return refused
                ? Response.json({ code: 'permission_denied' }, { status: 403 })
                : Response.json({ ...machine, resource: { ...machine.resource, value: { name: 'stale-public-row', createdAt: 1000,
                    managedId: 'retained', teamId: 'team_one', projectId: 'prj_one' } } });
            if (address.pathname.endsWith('/admit-control')) {
                admissions++;
                if (refused) return Response.json({ code: 'managed_power_required' }, { status: 403 });
                expect(await new Response(init?.body).json()).toMatchObject({
                    action: actionId, input: resizeUnsupported ? { managedId: machine.id, size: { memoryBytes: 4294967296 } }
                        : { managedId: machine.id, intent: 'start', when: 'now' },
                });
                machine = { ...machine, desired: 'start', intentRevision: 3 };
                return Response.json({ machine, replayed: false, ...(resizeUnsupported ? { resizeProvisioner: provisioner } : {}) });
            }
            if (address.pathname.endsWith('/submit-intent')) {
                submitted++;
                return Response.json({ machine, submitted: true });
            }
            if (address.pathname.endsWith('/report-intent') || address.pathname.endsWith('/report-resize')) {
                reports++;
                const body: unknown = await new Response(init?.body).json();
                reported.push(body);
                if (reportFailed) return Response.json({ code: 'managed_request_failed', message: 'private-home-report-body' }, { status: 503 });
                if (body && typeof body === 'object' && 'observation' in body) {
                    machine = ManagedMachineV1Schema.parse({ ...machine, observation: body.observation });
                }
                return Response.json({ machine });
            }
            return homes.request(url, init);
        } });
    onTestFinished(() => connection.dispose());
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    const { createUiConnectedAccountContent } = await import('@/sync/ops/connectedAccounts/connectedAccountContent');
    const { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } =
        await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const content = createUiConnectedAccountContent(account);
    const mode = await content.resolveAccountMode();
    credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: selected, authenticationModeId: 'token',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'selected-config',
        content: content.seal('credential', mode, { v: 1, values: { token: secret } }), metadata: { scopes: [] } });
    configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: selected },
        authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationRevision: 'selected-config', configurationContent: content.seal('configuration', mode, {
            values: { teamId: 'team_one', projectId: 'prj_one' }, secretRefs: {},
        }) });
    const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(account.accountLifetime.scope);
    expect((await reader.ensureCurrentAccountExecution(PLUGIN_MANIFEST.id)).kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing admitted Account projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
    const backend = createPluginUiCommonJsLoaderBackend();
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web', reader,
        accountLifetime: account.accountLifetime, loaderBackend: { ...backend, async loadInstalledBundle(input) {
            // The evaluated JS export is the byte-loader boundary. Every
            // wrapped handler is the real public authored implementation.
            const activate = await backend.loadInstalledBundle!(input) as (api: PluginAccountApi) => unknown;
            return (api: PluginAccountApi) => activate({ ...api, actions: { ...api.actions, register(id, handler, options) {
                return api.actions.register(id, (value, context) => { roles.push(id); return handler(value, context); }, options);
            } } });
        } } });
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
    onTestFinished(publishCommittedAppShellPluginUiProjection(() => reader.readAccountUiProjection()));
    onTestFinished(registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
        invocationSurface, hostAction, readProjection: () => reader.readAccountUiProjection(), readNavigationBinding: () => null,
        reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
    })));
    vendorHttp.mockImplementation(async (url, init) => {
        const address = new URL(String(url));
        const path = address.pathname;
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
        if (path === '/v2/sandboxes/sessions/sbx_one/cmd') {
            guestBoots++;
            return Response.json({ command: { id: 'cmd_one', sessionId: 'sbx_one', exitCode: null } });
        }
        if (path === '/v2/sandboxes/sessions/sbx_one/cmd/cmd_one') return Response.json({
            command: { id: 'cmd_one', sessionId: 'sbx_one', exitCode: guestStartup ? 7 : 0 },
        });
        if (path === '/v2/sandboxes/sessions/sbx_one/cmd/cmd_one/logs') return new Response(
            JSON.stringify({ stream: 'stderr', data: guestStartup ? 'private-guest-startup-output' : '' }) + '\n');
        if (path === '/v2/sandboxes/snapshots/snap_one') return Response.json({ snapshot: {
            id: 'snap_one', sourceSessionId: 'sbx_one', status: 'created', createdAt: 1000,
        } });
        if (path === '/v2/sandboxes/same-native') {
            if (nativeRefused) return Response.json({ error: { code: 'FORBIDDEN', message: 'private-native-refusal-body' } }, { status: 403 });
            if (address.searchParams.get('resume') === 'true') nativeResumes++;
            return Response.json({ sandbox: {
            name: 'same-native', createdAt: 1000, currentSessionId: 'sbx_one', currentSnapshotId: 'snap_one', persistent: true,
            status: nativeResumes ? 'running' : 'stopped', tags: { 'happier-managed-id': 'retained' }, networkPolicy: { mode: 'allow-all' },
        }, session: { id: 'sbx_one', sourceSandboxName: 'same-native', projectId: 'prj_one', createdAt: 1000,
            networkPolicy: { mode: 'allow-all' } } });
        }
        throw new Error(`Unexpected native power HTTP ${path}`);
    });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
    const input = resizeUnsupported ? { homeId, managedId: machine.id, size: { memoryBytes: 4294967296 } }
        : { homeId, managedId: machine.id, expectedRevision: 2, when: 'now' as const, intent: 'start' as const };
    const result = await createDefaultActionExecutor().execute(actionId, input,
        bindPresentUserActionConfirmation(actionId, input, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'foreground-power' }));
    // The original Action already owns review. A provider role cannot ask the
    // person a second time instead of consuming its exact reviewed-child proof.
    expect(Modal.show).not.toHaveBeenCalled();
    if (resizeUnsupported) {
        expect(result).toMatchObject({ ok: true, result: { result: { kind: 'unsupported', dimension: 'memoryBytes' } } });
        if (!result.ok) throw new Error(result.errorCode);
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        expect(getActionSpec(actionId).outputSchema!.safeParse(result.result).success).toBe(true);
        expect({ admissions, submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
            admissions: 1, submitted: 0, reports: 1, nativeResumes: 0, guestBoots: 0, roles: [] });
        const retainedLogs = log.getLogs().slice(logStart);
        expect(retainedLogs).toContain(JSON.stringify({ phase: actionId, errorClass: 'ManagedMachineControllerError',
            errorCode: 'managed_request_failed', httpStatus: null }));
        expect(JSON.stringify({ result, retainedLogs })).not.toMatch(/private-home-report-body|private-selected-power-token/);
        return;
    }
    if (refused) {
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_power_required' });
        expect({ submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
            submitted: 0, reports: 0, nativeResumes: 0, guestBoots: 0, roles: [] });
        return;
    }
    if (reportFailed || nativeRefused) {
        // The first guest command is the public provider's platform probe;
        // its nonzero exit authors this bootstrap failure before daemon start.
        expect(result).toMatchObject({ ok: false, errorCode: guestStartup ? 'vercel_guest_unsupported'
            : nativeRefused ? 'provider_unavailable' : 'managed_request_failed' });
        if (nativeRefused) expect(result).toMatchObject({ details: {
            kind: 'managedNative', nativeCause: { httpStatusClass: '4xx' },
        } });
        expect(reported).toEqual([expect.objectContaining({ result: expect.objectContaining(nativeRefused
            ? { kind: 'refused', code: 'provider_unavailable' } : { kind: 'confirmed' }) })]);
        expect({ admissions, submitted, reports, nativeResumes, guestBoots }).toEqual({
            admissions: 1, submitted: 1, reports: 1, nativeResumes: nativeRefused ? 0 : 1, guestBoots: guestStartup ? 1 : 0 });
        const retainedLogs = log.getLogs().slice(logStart);
        if (reportFailed && (guestStartup || nativeRefused)) expect(retainedLogs).toContain(JSON.stringify({ phase: 'machines.managed.power.set',
            errorClass: 'ManagedMachineControllerError', errorCode: 'managed_request_failed', httpStatus: null }));
        else expect(retainedLogs.some(entry => entry.includes('"errorCode":"managed_request_failed"'))).toBe(false);
        const publicEvidence = JSON.stringify({ result, retainedLogs });
        for (const privateValue of [secret, 'private-home-report-body', 'private-guest-startup-output', 'private-native-refusal-body']) {
            expect(publicEvidence).not.toContain(privateValue);
        }
        return;
    }
    expect(result, JSON.stringify({ result, reported, roles, requests })).toMatchObject({ ok: true,
        result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
    expect(reported).toEqual([expect.objectContaining({ result: { kind: 'confirmed' },
        observation: expect.objectContaining({ power: 'running', storage: 'retained' }) })]);
    expect(result.ok && result.result).not.toHaveProperty('operation');
    expect({ admissions, submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
        admissions: 1, submitted: 1, reports: 1, nativeResumes: 1, guestBoots: 0, roles: ['inspect', 'power', 'inspect'] });
    expect(machine.observation?.power).toBe('running');
    expect(JSON.stringify(result)).not.toContain(secret);
});
