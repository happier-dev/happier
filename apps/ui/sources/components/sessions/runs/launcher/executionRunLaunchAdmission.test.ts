import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, buildBackendTargetKeyV2, FeatureGatesSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { TeamCredentialProviderModelSelectionV1Schema, TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, createMachineFixture, createPlainAccountEncryptionCurrentnessFixture, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { Modal } from '@/modal';
import { createPluginActionInputSelectionHostApiHandler } from '@/components/plugins/surfaces/pluginActionInputSelectionHostApi';
import type { SecretRequirementModalResult } from '@/components/secrets/requirements';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetTeamsDirectoryEngineForTests } from '@/sync/engine/teams/teamsDirectoryEngine';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import '@/sync/syncEngine';
import { StartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import type { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { applyAcpCatalogSnapshot, beginAcpCatalogLoad, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { admitExecutionRunLaunchTarget } from './executionRunLaunchAdmission';
import { useExecutionRunLaunchContext } from './useExecutionRunLaunchContext';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn<(input: Parameters<typeof machineRpcWithServerScope>[0]) => Promise<unknown>>(),
    sessionRpc: vi.fn<(input: Parameters<typeof sessionRpcWithServerScope>[0]) => Promise<unknown>>(),
    accountId: 'launch-account',
    credentialListeners: new Set<(event: HomeCredentialMutationEvent) => void>(),
}));
let restoreExecutorModuleLoader: (() => void) | undefined;

// Secure persistence, Home HTTP/RPC and native styling are replaced boundaries.
// Admission, exact scope retirement, credential policy, Action execution and resume are real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async () => ({
                token: `e30.${Buffer.from(JSON.stringify({ sub: boundary.accountId })).toString('base64url')}.signature`,
            }),
        },
        subscribeHomeCredentialMutations: (listener) => {
            boundary.credentialListeners.add(listener);
            return () => { boundary.credentialListeners.delete(listener); };
        },
    });
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.rpc,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: boundary.sessionRpc,
    sessionRpcWithServerAccountScope: boundary.sessionRpc,
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function capabilityResponse(features: Readonly<{ secretReferenceOverlay: boolean; runScopedAgentBindings: boolean }>) {
    return { protocolVersion: 1, results: { 'tool.executionRuns': {
        ok: true, checkedAt: 1, data: { protocolVersion: 2,
            backends: { claude: { available: true, intents: ['review'], supportsVendorResume: true } }, features: {
            detachedScope: true, startAndWait: true, ...features,
        } },
    } } };
}

const supportedCapabilities = capabilityResponse({ secretReferenceOverlay: true, runScopedAgentBindings: true });

function activeProfileCatalog(profile: ReturnType<typeof AIBackendProfileSchema.parse>): Extract<ProfileCatalogSnapshotV1, { status: 'ready' }> {
    return { status: 'ready', authority: 'active', source: 'destination', diagnostics: [], referenceGuardRevision: 1,
        records: [{ record: { v: 1, id: profile.id, definition: { kind: 'legacy', profile },
            enabled: true, secretBindings: {}, promptStack: [] }, revision: 1 }],
        controlRevision: 1, control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0,
            migratedLogicalRevision: 1, inventory: [{ kind: 'account_row', id: profile.id, revision: 1 }] } } };
}

async function launchFixture() {
    const home = await upsertServerProfileOnly({ serverUrl: 'https://launch-admission.example.test', name: 'Launch test Home' });
    const requestedServerIds = [home.id];
    const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings(requestedServerIds));
    const accountLifetime = bindingHook.getCurrent().get(home.id);
    expect(accountLifetime?.isCurrent()).toBe(true);
    if (!accountLifetime) throw new Error('Credential boundary did not bind the test Account');
    applyAcpCatalogSnapshot(accountLifetime.scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
    const session = createSessionFixture({
        id: 'rejoined-session', serverId: home.id, active: false,
        metadata: {
            path: '/work/rejoined', host: 'test-host', homeDir: '/work', machineId: 'launch-machine',
            flavor: 'claude', claudeSessionId: 'retained-vendor-session',
        },
    });
    const machine = createMachineFixture({ id: 'launch-machine', metadata: {
        host: 'test-host', platform: 'linux', happyCliVersion: '0.0.0-test', homeDir: '/work', happyHomeDir: '/work/.happier',
    } });
    storage.setState({
        // The focused Account is deliberately another Account. Exact resume must
        // retain the chooser's credential scope instead of borrowing this one.
        profileScope: { serverId: home.id, accountId: 'focused-other-account' },
        settingsScope: { serverId: home.id, accountId: 'focused-other-account' },
        sessions: { [session.id]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] },
    });
    const input = {
        sessionId: session.id, serverId: home.id, session,
        exactSettings: settingsDefaults, settings: settingsDefaults, accountLifetime,
        machineId: machine.id, machineTarget: { machineId: machine.id, basePath: '/work/rejoined' },
        machineReachable: true, resumeCapabilityOptions: { accountSettings: settingsDefaults },
        defaultBackend: resolveSessionActionDefaultBackend({ session }),
        requirements: { secretReferenceOverlay: true, teamCredentialModel: true },
        readinessOperationId: 'review-selection',
    } satisfies Parameters<typeof admitExecutionRunLaunchTarget>[0];
    return { home, bindingHook, input, session, machine };
}

it('admits an exact detached workspace without resuming or acquiring a Session', async () => {
    const { input, bindingHook } = await launchFixture();
    boundary.rpc.mockResolvedValue(supportedCapabilities);
    await expect(admitExecutionRunLaunchTarget({ ...input, sessionId: null, session: null,
        cwd: '/work/rejoined', defaultBackend: null })).resolves.toBeUndefined();
    expect(boundary.rpc.mock.calls.some(([call]) => call.machineId === 'launch-machine')).toBe(true);
    expect(boundary.sessionRpc).not.toHaveBeenCalled();
    await bindingHook.unmount();
});

beforeEach(() => {
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    boundary.accountId = 'launch-account';
    boundary.rpc.mockReset();
    boundary.sessionRpc.mockReset();
    storage.setState(storage.getInitialState(), true);
    resetServerFeaturesClientForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
});

afterEach(() => {
    restoreExecutorModuleLoader?.();
    restoreExecutorModuleLoader = undefined;
    standardCleanup();
    resetRuntimeFetch();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    vi.restoreAllMocks();
    storage.setState(storage.getInitialState(), true);
});

describe('real execution Run launch admission', () => {
    it('projects the owner-applied draft selection instead of visible pending intent', async () => {
        const { input, session } = await launchFixture();
        const applied = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'applied-model' };
        storage.setState({ settingsScope: input.accountLifetime.scope, settings: settingsDefaults,
            sessions: { [session.id]: { ...session, active: true, modelMode: 'pending-model',
                metadataLayoutVersion: 1, ownerMetadataView: { ...session.metadata!, connectedServices: {
                    v: 2, bindingsByServiceId: { 'happier.agent.claude/anthropic': {
                        source: 'connected', selection: 'group', groupId: 'parent-pool',
                    } },
                }, sessionAppliedModelV1: {
                    v: 1, provider: 'claude', modelId: 'applied-model', selection: applied, updatedAt: 1,
                } },
            } },
        });
        const hook = await renderHook(() => useExecutionRunLaunchContext(session.id, input.serverId));
        expect(hook.getCurrent().inheritedModelSelection).toEqual(applied);
        expect(hook.getCurrent().inheritedRoutePresentation?.applied).toMatchObject({
            kind: 'native', authSource: 'connected', connectedCount: 1, modelId: 'applied-model',
        });
        expect(hook.getCurrent().inheritedConnectedServicesSelection?.bindingsByServiceId['happier.agent.claude/anthropic'])
            .toEqual({ source: 'connected', selection: 'group', groupId: 'parent-pool' });
        await act(async () => storage.setState({ sessions: { [session.id]: {
            ...storage.getState().sessions[session.id]!, ownerMetadataView: null,
        } } }));
        expect(hook.getCurrent().inheritedModelSelection).toBeNull();
        expect(hook.getCurrent().inheritedRoutePresentation?.applied).toEqual({ kind: 'unknown' });
    });

    it('admits the exact configured ACP target from a ready Account row', async () => {
        const { input } = await launchFixture();
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'review-bot', name: 'review-bot', title: 'Review Bot', command: 'acp', args: [], createdAt: 1, updatedAt: 1,
        }] });
        applyAcpCatalogSnapshot(input.accountLifetime.scope, { status: 'ready', revision: 2, record }, true);
        await expect(admitExecutionRunLaunchTarget({ ...input, session: { ...input.session, active: true },
            defaultBackend: { ...input.defaultBackend!, agentTarget: null, backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' } },
            requirements: { secretReferenceOverlay: false, teamCredentialModel: false },
        })).resolves.toBeUndefined();
    });
    it('refuses an authored configured ACP Run from a bundled host after the Account catalog starts loading', async () => {
        const { input, session } = await launchFixture();
        storage.setState({
            settingsScope: input.accountLifetime.scope, settings: settingsDefaults,
            sessions: { [session.id]: { ...session, active: true } },
        });
        const hook = await renderHook(() => useExecutionRunLaunchContext(session.id, input.serverId));
        await act(async () => {
            applyAcpCatalogSnapshot(input.accountLifetime.scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
            beginAcpCatalogLoad(input.accountLifetime.scope);
        });
        await expect(hook.getCurrent().startAction('subagents.delegate.start', {
            backendTargetKeys: ['acpBackend:review-bot'], instructions: 'Inspect the work', permissionMode: 'read_only',
        }, 'configured-run')).rejects.toMatchObject({ code: 'acp_catalog_unavailable' });
    });
    it('refuses a retained configured ACP launch after its Account catalog starts loading', async () => {
        const { input } = await launchFixture();
        applyAcpCatalogSnapshot(input.accountLifetime.scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
        beginAcpCatalogLoad(input.accountLifetime.scope);
        const launch = { ...input,
            session: { ...input.session, active: true },
            defaultBackend: { ...input.defaultBackend!, agentTarget: null, backendTarget: { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' } },
            requirements: { secretReferenceOverlay: false, teamCredentialModel: false },
        };
        await expect(admitExecutionRunLaunchTarget(launch)).rejects.toMatchObject({ code: 'acp_catalog_unavailable' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it.each(['loading', 'partial', 'legacy', 'unavailable'] as const)('refuses a Session profile from a %s catalog before launch', async (state) => {
        const { input } = await launchFixture();
        const profile = AIBackendProfileSchema.parse({ id: 'admission-profile', name: 'Admission profile' });
        const ready = activeProfileCatalog(profile);
        const catalog: ProfileCatalogSnapshotV1 = state === 'loading' ? { status: 'loading' }
            : state === 'unavailable' ? { status: 'unavailable', reason: 'unreachable' }
            : state === 'partial' ? { ...ready, status: 'partial' }
            : { ...ready, source: 'legacy' };
        applyProfileCatalogSnapshot(input.accountLifetime.scope, catalog, true);
        const launch = { ...input, session: { ...input.session, active: true, metadata: { ...input.session.metadata!, profileId: profile.id } },
            requirements: { secretReferenceOverlay: false, teamCredentialModel: false } };

        await expect(admitExecutionRunLaunchTarget(launch)).rejects.toThrow();
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('admits a Session profile from a ready active catalog', async () => {
        const { input } = await launchFixture();
        const profile = AIBackendProfileSchema.parse({ id: 'admission-profile', name: 'Admission profile' });
        applyProfileCatalogSnapshot(input.accountLifetime.scope, activeProfileCatalog(profile), true);

        await expect(admitExecutionRunLaunchTarget({ ...input,
            session: { ...input.session, active: true, metadata: { ...input.session.metadata!, profileId: profile.id } },
            requirements: { secretReferenceOverlay: false, teamCredentialModel: false } })).resolves.toBeUndefined();
    });

    it('admits a fresh destination Profile catalog without a predecessor transfer control', async () => {
        const { input } = await launchFixture();
        applyProfileCatalogSnapshot(input.accountLifetime.scope, { status: 'ready', source: 'destination',
            authority: 'inactive', records: [], diagnostics: [], referenceGuardRevision: 'absent', control: null,
            controlRevision: 'absent' }, true);

        await expect(admitExecutionRunLaunchTarget({ ...input,
            session: { ...input.session, active: true, metadata: { ...input.session.metadata!, profileId: 'codex' } },
            requirements: { secretReferenceOverlay: false, teamCredentialModel: false } })).resolves.toBeUndefined();
    });

    it.each(['Triage host selection', 'StartReviewDialog'] as const)('composes %s with real Secret and Team controls, consent and stopped Session resume', async (entry) => {
        restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
        const { input, home, session, machine } = await launchFixture();
        const profile = AIBackendProfileSchema.parse({ id: 'review-profile', name: 'Review profile',
            envVarRequirements: [{ name: 'OPENAI_API_KEY', required: true, kind: 'secret' }] });
        const secret = { id: formatSharedSavedSecretRefV1('review-secret'), name: 'Review key', kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'synthetic-test-value' }, createdAt: 1, updatedAt: 1 };
        const settings = settingsParse(settingsDefaults);
        const secretMaterials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
            resourceId: 'review-secret', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: secret.name, kind: secret.kind, value: secret.encryptedValue.value } },
            entry: { ref: secret.id, source: 'shared_resource', relationship: 'owner', name: secret.name, kind: secret.kind,
                encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] });
        const teamModel = TeamCredentialProviderModelSelectionV1Schema.parse({
            kind: 'team_credential_provider_model', teamId: 'review-team', resourceId: 'review-resource',
            expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }), modelId: 'shared-review-model',
        });
        const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: teamModel.resourceId, teamId: teamModel.teamId, displayName: 'Shared review provider', resourceRevision: 3,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'team_visibility_required',
            providerModels: [{ selection: teamModel, descriptor: { id: teamModel.modelId, name: 'Shared review model' },
                application: { agentTargetKey: teamModel.agentTargetKey,
                    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' },
                sourceRevision: 'source-1', availability: 'available' }],
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 } },
        });
        const httpRequests: { path: string; authorization: string | null }[] = [];
        // Actual Home feature, directory and catalog HTTP responses. Exact
        // Account authorization, parsing, snapshot loading and picker policy stay real.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            httpRequests.push({ path, authorization: new Headers(init?.headers).get('Authorization') });
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }));
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(secretMaterials);
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            const body = path === '/v1/features'
                ? FeaturesResponseSchema.parse(createRootLayoutFeaturesResponse({ features: { teams: FeatureGatesSchema.shape.teams.parse({
                    enabled: true, credentialResources: { enabled: true } }) } }))
                : path === '/v1/teams/list'
                    ? { items: [teamSummaryFixture({ id: teamModel.teamId, capabilities: teamCapabilitiesFixture({}) })], nextCursor: null }
                    : path === '/v1/teams/credential-resources/entitled/list'
                        ? { resources: [teamResource], nextCursor: null } : null;
            return Response.json(body, { status: body ? 200 : 404 });
        });
        storage.setState({ settings, settingsVersion: 1, settingsScope: input.accountLifetime.scope,
            sessions: { [session.id]: { ...session, metadata: { ...session.metadata!, profileId: profile.id } } },
            machines: { [machine.id]: { ...machine, activeAt: Date.now() } },
            machineListByServerId: { [home.id]: [{ ...machine, activeAt: Date.now() }] },
        });
        applyProfileCatalogSnapshot(input.accountLifetime.scope, activeProfileCatalog(profile), true);
        const readiness = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return supportedCapabilities;
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                request.onIssued?.();
                const payload = request.payload as { spawnNonce?: string };
                return { type: 'success', sessionIdStatus: 'pending', spawnNonce: payload.spawnNonce };
            }
            if (request.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) return readiness.promise;
            // Catalog/feature availability remains absent rather than borrowing a
            // generated Agent projection. Bundled native Session resume is still real.
            return { error: 'Method not found', errorCode: 'METHOD_NOT_FOUND' };
        });
        const shown = createDeferred<Parameters<typeof Modal.show>[0]>();
        const presentations: Parameters<typeof Modal.show>[0][] = [];
        vi.spyOn(Modal, 'show').mockImplementation((config) => {
            presentations.push(config);
            if (presentations.length === 1) shown.resolve(config);
            return `launch-modal-${presentations.length}`;
        });
        vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const consent = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        boundary.sessionRpc.mockResolvedValue({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-sidechain' });
        const handler = createPluginActionInputSelectionHostApiHandler({
            host: { machineId: machine.id, serverId: home.id, targetPluginId: 'acme.triage',
                accountLifetime: input.accountLifetime }, isCurrent: () => true,
        });
        if (!handler) throw new Error('Review selection handler was not admitted');
        let settled = false;
        const selecting = entry === 'Triage host selection'
            ? Promise.resolve(handler({ version: 1, requestId: 'review-selection', surface: {
                pluginId: 'acme.triage', contributionId: 'pull-request', surfaceId: 'review-selection',
                placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
            }, method: 'selectActionInput', payload: {
                hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
                sessionId: session.id, serverId: home.id,
                draft: { engineIds: ['claude'], instructions: 'Review the selected comparison' },
            } })).then((result) => { settled = true; return result; }) : null;
        const started = createDeferred<void>();
        const screen = selecting
            ? await (async () => {
                const config = await shown.promise;
                return renderScreen(React.createElement(config.component, { ...config.props, onClose: () => {} }));
            })()
            : await renderScreen(React.createElement(StartReviewDialog, {
                sessionId: session.id, serverId: home.id, cwd: '/work/rejoined',
                comparison: { kind: 'workingTree' }, comparisonId: 'captured-comparison', scopeLabel: 'Pending changes',
                preselectedEngineIds: ['claude'], defaultWalkthrough: false, onClose: () => {},
                onStarted: () => { settled = true; started.resolve(); },
            }));
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const secretPresentation = presentations.at(-1);
        const resolveSecret = secretPresentation?.props?.onResolve as ((result: SecretRequirementModalResult) => void) | undefined;
        expect(resolveSecret).toBeTypeOf('function');
        await act(async () => resolveSecret?.({ action: 'selectSaved', envVarName: 'OPENAI_API_KEY',
            secretId: secret.id, setDefault: false }));
        const teamOptionTestId = `model-picker-overlay-option:${sessionModelSelectionKey(teamModel)}`;
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId(teamOptionTestId), JSON.stringify({ httpRequests, text: screen.getTextContent() })).not.toBeNull();
        });
        await screen.pressByTestIdAsync(teamOptionTestId);
        await vi.waitFor(() => expect(consent).toHaveBeenCalled());
        const submitTestId = selecting ? 'review-execution-run-launch-continue' : 'start-review-start';
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId(submitTestId)?.props.disabled).toBe(false); });
        await screen.pressByTestIdAsync(submitTestId);
        await vi.waitFor(() => expect(boundary.rpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE)).toBe(true));
        expect(settled).toBe(false);
        expect(boundary.sessionRpc).not.toHaveBeenCalled();
        expect(boundary.rpc.mock.calls.find(([request]) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)?.[0])
            .toMatchObject({ machineId: machine.id, serverId: home.id, accountId: 'launch-account',
                payload: { sessionId: session.id, resume: 'retained-vendor-session' } });
        await act(async () => {
            storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: { ...state.sessions[session.id]!, active: true } } }));
            readiness.resolve({ status: 'success', sessionId: session.id });
        });
        const credentials = {
            secretReferenceOverlay: { v: 1, bindings: { OPENAI_API_KEY: { ref: secret.id, revision: 1 } } },
            teamCredentialModel: teamModel,
            teamCredentialSessionBindingConsent: { v: 1, sessionId: session.id, teamId: teamModel.teamId,
                resourceId: teamModel.resourceId, expectedResourceRevision: teamModel.expectedResourceRevision },
        };
        if (selecting) {
            expect(await selecting).toEqual({ kind: 'executionRunLaunch', input: credentials });
            expect(boundary.sessionRpc).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(async () => { await act(async () => {}); expect(settled, screen.getTextContent()).toBe(true); });
            await started.promise;
            expect(boundary.sessionRpc.mock.calls[0]?.[0]).toMatchObject({ sessionId: session.id, serverId: home.id,
                method: SESSION_RPC_METHODS.EXECUTION_RUN_START, payload: { ...credentials, intent: 'review',
                    intentInput: { comparisonId: 'captured-comparison' } } });
            expect(JSON.stringify(boundary.sessionRpc.mock.calls)).not.toContain(secret.encryptedValue.value);
        }
        expect(httpRequests.filter((request) => request.path.startsWith('/v1/teams/')))
            .toEqual(expect.arrayContaining([
                { path: '/v1/teams/list', authorization: expect.stringContaining('Bearer ') },
                { path: '/v1/teams/credential-resources/entitled/list', authorization: expect.stringContaining('Bearer ') },
            ]));
        expect(boundary.rpc.mock.calls.some(([request]) => request.method.includes('action.invoke'))).toBe(false);
    });
    it('preflights Secret and Team on the exact Machine and waits for stopped rejoined Session readiness', async () => {
        const { input, home } = await launchFixture();
        const readiness = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return supportedCapabilities;
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                request.onIssued?.();
                return { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'execution-run-host-review-selection' };
            }
            if (request.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) return readiness.promise;
            throw new Error(`Unexpected network method: ${request.method}`);
        });
        let settled = false;
        const admission = admitExecutionRunLaunchTarget(input).then(() => { settled = true; });
        await vi.waitFor(() => expect(boundary.rpc.mock.calls.some(([request]) =>
            request.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE)).toBe(true));
        expect(settled).toBe(false);
        const requests = boundary.rpc.mock.calls.map(([request]) => request);
        expect(requests.map((request) => request.method)).toEqual([
            RPC_METHODS.CAPABILITIES_DETECT, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
            RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        ]);
        expect(requests.every((request) => request.machineId === 'launch-machine' && request.serverId === home.id)).toBe(true);
        expect(requests[0].payload).toEqual({ requests: [{ id: 'tool.executionRuns' }] });
        expect(requests[1]).toMatchObject({ accountId: 'launch-account', preferScoped: true,
            payload: { type: 'resume-session', sessionId: input.sessionId, directory: '/work/rejoined',
                resume: 'retained-vendor-session', spawnNonce: 'execution-run-host-review-selection' } });
        readiness.resolve({ status: 'success', sessionId: input.sessionId });
        await admission;
        expect(settled).toBe(true);
    });

    it.each([
        { field: 'secretReferenceOverlay', requirements: { secretReferenceOverlay: true, teamCredentialModel: false }, code: 'execution_run_secret_reference_overlay_update_required' },
        { field: 'runScopedAgentBindings', requirements: { secretReferenceOverlay: false, teamCredentialModel: true }, code: 'execution_run_protocol_unsupported' },
    ] as const)('refuses unsupported $field before resuming a stopped Session', async ({ field, requirements, code }) => {
        const { input } = await launchFixture();
        boundary.rpc.mockResolvedValue(capabilityResponse({ secretReferenceOverlay: true, runScopedAgentBindings: true, [field]: false }));
        await expect(admitExecutionRunLaunchTarget({ ...input, requirements })).rejects.toThrow(code);
        expect(boundary.rpc.mock.calls.map(([request]) => request.method)).toEqual([RPC_METHODS.CAPABILITIES_DETECT]);
    });

    it('refuses a changed Machine after capability admission and before resume', async () => {
        const { input, session, machine, home } = await launchFixture();
        const capability = createDeferred<unknown>();
        boundary.rpc.mockReturnValue(capability.promise);
        const admission = admitExecutionRunLaunchTarget(input);
        expect(boundary.rpc).toHaveBeenCalled();
        const replacement = createMachineFixture({ ...machine, id: 'replacement-machine' });
        storage.setState({
            sessions: { [session.id]: { ...session, metadata: { ...session.metadata!, machineId: replacement.id } } },
            machines: { [replacement.id]: replacement }, machineListByServerId: { [home.id]: [replacement] },
        });
        capability.resolve(supportedCapabilities);
        await expect(admission).rejects.toThrow('execution_run_target_changed');
        expect(boundary.rpc.mock.calls.map(([request]) => request.method)).toEqual([RPC_METHODS.CAPABILITIES_DETECT]);
    });

    it('refuses an already retired exact Account without issuing network work', async () => {
        const { input, bindingHook } = await launchFixture();
        await bindingHook.unmount();
        expect(input.accountLifetime.isCurrent()).toBe(false);
        await expect(admitExecutionRunLaunchTarget(input)).rejects.toThrow();
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('aborts pending resume and refuses settlement when the exact Account credential is replaced', async () => {
        const { input, home, bindingHook } = await launchFixture();
        const spawn = createDeferred<unknown>();
        let spawnSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementation(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return supportedCapabilities;
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                request.onIssued?.();
                spawnSignal = request.signal;
                return spawn.promise;
            }
            throw new Error(`Unexpected network method: ${request.method}`);
        });
        const admission = admitExecutionRunLaunchTarget(input);
        const rejection = expect(admission).rejects.toThrow();
        await vi.waitFor(() => expect(spawnSignal).toBeDefined());
        boundary.accountId = 'replacement-account';
        await act(async () => {
            for (const listener of boundary.credentialListeners) listener({
                serverId: home.id, serverUrl: home.serverUrl, kind: 'credentials_set',
            });
        });
        expect(input.accountLifetime.isCurrent()).toBe(false);
        expect(bindingHook.getCurrent().get(home.id)?.accountId).toBe('replacement-account');
        expect(spawnSignal?.aborted).toBe(true);
        spawn.resolve({ type: 'success', sessionId: input.sessionId });
        await rejection;
    });
});
