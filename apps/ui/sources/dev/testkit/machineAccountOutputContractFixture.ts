import { expect, onTestFailed, onTestFinished, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from './harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from './fixtures/accountEncryptionCurrentness';
import { createDesktopSecureStorageBoundary } from './mocks/desktopSecureStorage';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-vercel/src/manifest';
import { log } from '@/log';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import { randomUUID } from '@/platform/randomUUID';

/** These cases use the connected UI Account and the real Home HTTP/SQLite
 * producers. Persistence setup creates disposable Machines, never Action results. */
export function createAccountOutputFixture(params: Readonly<{
    serverId: string;
    homeId: string;
    baseUrl: string;
    ownerToken: string;
    ownerAccountId: string;
    memberToken: string;
    memberAccountId: string;
    machineId: string;
    createOutputMachine(input: Readonly<{ id: string; active?: boolean; accountId?: string }>): Promise<string>;
    createOutputManagedMachine(input: Readonly<{ id: string; setupGuestId?: string }>): Promise<Readonly<{ managedId: string; intentRevision: number }>>;
    /** A genuinely connected receiver, when the enclosing journey supplies one. */
    replacementMachineId?: string;
}>) {
    const executor = import('@/sync/ops/actions/defaultActionExecutor')
        .then(({ createDefaultActionExecutor }) => createDefaultActionExecutor());
    const target = (machineId = params.machineId) => ({ serverId: params.homeId, machineId });
    const principal = { kind: 'account' as const, accountId: params.memberAccountId };
    const oldId = `${params.machineId}-replace-old`;
    const removeId = `${params.machineId}-remove`;
    const leaveId = `${params.machineId}-leave`;
    const request = async (token: string, machineId: string, method: string, body: unknown) => {
        const response = await fetch(`${params.baseUrl}/v1/machines/${encodeURIComponent(machineId)}/access`, {
            method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Machine access fixture setup failed: HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'saved') {
            throw new Error('Machine access fixture setup did not save a real grant');
        }
    };
    const ensureOld = () => params.createOutputMachine({ id: oldId, active: false });
    const cases = new Map<ActionId, () => unknown | Promise<unknown>>([
        ['machines.managed.get', async () => ({ homeId: params.homeId,
            managedId: (await params.createOutputManagedMachine({ id: `${params.machineId}-retained` })).managedId })],
        ['machines.managed.references.get', async () => ({ homeId: params.homeId,
            managedId: (await params.createOutputManagedMachine({ id: `${params.machineId}-references` })).managedId })],
        // The birth owner performs its real relationship-index lookup and
        // emits the declared null-source result when no birth exists.
        ['machines.managed.birth.get', () => ({ homeId: params.homeId, managedId: `${params.machineId}-no-birth` })],
        ['machines.managed.cancel', async () => {
            const machine = await params.createOutputManagedMachine({ id: `${params.machineId}-cancel` });
            return { homeId: params.homeId, managedId: machine.managedId, expectedIntentRevision: machine.intentRevision };
        }],
        ['machines.managed.setup.skip', async () => {
            const setupGuestId = await params.createOutputMachine({ id: `${params.machineId}-setup-guest` });
            const machine = await params.createOutputManagedMachine({ id: `${params.machineId}-setup`, setupGuestId });
            return { homeId: params.homeId, managedId: machine.managedId, expectedIntentRevision: machine.intentRevision };
        }],
        ['machines.access.grant.set', () => ({ ...target(), principal, level: 'admin' })],
        ['machines.access.grant.remove', async () => {
            await request(params.ownerToken, params.machineId, 'PUT', { principal, level: 'view' });
            return { ...target(), principal };
        }],
        ['machines.access.leave', async () => {
            await params.createOutputMachine({ id: leaveId, active: false, accountId: params.memberAccountId });
            await request(params.memberToken, leaveId, 'PUT', {
                principal: { kind: 'account', accountId: params.ownerAccountId }, level: 'view',
            });
            return target(leaveId);
        }],
        ['machines.remove', async () => target(await params.createOutputMachine({ id: removeId, active: false }))],
        ['machines.replacement.clear', async () => target(await ensureOld())],
    ]);
    if (params.replacementMachineId) {
        cases.set('machines.replacement.set', async () => ({ ...target(await ensureOld()),
            replacementMachineId: params.replacementMachineId }));
    }
    return {
        cases,
        async execute(id: ActionId, input: unknown): Promise<ActionExecuteResult> {
            return (await executor).execute(id, input, bindPresentUserActionConfirmation(id, input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: params.serverId, serverIdentityId: params.homeId,
                runtimeAccountId: params.ownerAccountId, actionRequestId: randomUUID(),
            }));
        },
        async close() {
            await request(params.ownerToken, params.machineId, 'PUT', { principal, level: 'view' });
        },
    };
}


/** The caller installs only the external SDK/packaged-asset boundaries and
 * prepares the real Vercel inventory with prepareAuthenticationInventory.
 * Home responses here are upstream HTTP facts: the public Account executor,
 * credential materializer, compiled provider and native result producers run. */
export async function executeManagedAccountPowerOutputScenario(
    outcome: 'confirmed' | 'admission-refused' | 'guest-startup-report-failed'
        | 'native-refused-report-failed' | 'confirmed-report-failed'
        | 'native-refused-report-confirmed' | 'resize-unsupported-report-failed'
        | 'delete-refused-report-failed' | 'delete-refused-report-confirmed' | 'delete-confirmed-report-failed',
    vendorHttp: ReturnType<typeof vi.fn<typeof fetch>>,
) {
    const refused = outcome === 'admission-refused';
    const guestStartup = outcome === 'guest-startup-report-failed';
    const nativeRefused = outcome.startsWith('native-refused-');
    const reportFailed = outcome.endsWith('report-failed');
    const resizeUnsupported = outcome === 'resize-unsupported-report-failed';
    const deleting = outcome.startsWith('delete-');
    const deleteRefused = outcome.startsWith('delete-refused-');
    const actionId = resizeUnsupported ? 'machines.managed.resize'
        : deleting ? 'machines.managed.delete' : 'machines.managed.power.set';
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
            value: { name: 'same-native', createdAt: 1000, managedId: 'retained', teamId: deleteRefused ? 'another-team' : 'team_one', projectId: 'prj_one' } },
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
                        : { managedId: machine.id, intent: deleting ? 'delete' : 'start', when: 'now' },
                });
                machine = { ...machine, desired: deleting ? 'delete' : 'start', intentRevision: 3 };
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
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
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
            if (deleting) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
            if (nativeRefused) return Response.json({ error: { code: 'FORBIDDEN', message: 'private-native-refusal-body' } }, { status: 403 });
            if (address.searchParams.get('resume') === 'true') nativeResumes++;
            return Response.json({ sandbox: {
            name: 'same-native', createdAt: 1000, currentSessionId: 'sbx_one', currentSnapshotId: 'snap_one', persistent: true,
            status: nativeResumes ? 'running' : 'stopped', tags: { 'happier-managed-id': 'retained' }, networkPolicy: { mode: 'allow-all' },
        }, session: { id: 'sbx_one', sourceSandboxName: 'same-native', projectId: 'prj_one', createdAt: 1000,
            networkPolicy: { mode: 'allow-all' } } });
        }
        if (deleting && path === '/v2/sandboxes/snapshots') return Response.json({ snapshots: [], pagination: { next: null } });
        throw new Error(`Unexpected native power HTTP ${path}`);
    });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
    const input = resizeUnsupported ? { homeId, managedId: machine.id, size: { memoryBytes: 4294967296 } }
        : deleting ? { homeId, managedId: machine.id, expectedRevision: 2, when: 'now' as const, intent: 'delete' as const, reviewedDependencies: true }
        : { homeId, managedId: machine.id, expectedRevision: 2, when: 'now' as const, intent: 'start' as const };
    const result = await createDefaultActionExecutor().execute(actionId, input,
        bindPresentUserActionConfirmation(actionId, input, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'foreground-power' }));
    return { refused, guestStartup, nativeRefused, reportFailed, resizeUnsupported, deleting, deleteRefused, actionId, logStart, result, reported, roles, requests, admissions, submitted, reports, nativeResumes, guestBoots, secret, machine };
}
