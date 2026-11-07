import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ScmHostingRepositoryPublishTargetSchema } from '@happier-dev/protocol/scm/repositoryProvisioning';
import type { PluginPublishController } from './usePluginPublish';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createMachineFixture, createDeferred, createActionExecutorBoundaryFixture, renderHook, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ForgeReleaseActionInputSchemasV1, ForgeReleaseActionResultSchemasV1 } from '@happier-dev/triage-protocol/releases/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View',
    Linking: { openURL: async () => { throw new Error('No native opener in this web client'); } } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/plugins/publish', params: { projectRoot: '/project', machineId: 'publisher-machine',
        serverIdentityId: 'srv_publisher' }, router: { push },
}).module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
const modal = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modal.show } }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const daemonReply = vi.fn<(request: SocketRpcRequestPayload) => unknown>();
const daemonRequests = installSessionActionRpcBoundary(request => daemonReply(request));
const { usePluginPublish, githubPublicationTargetId } = await import('./usePluginPublish');
const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const ids = ['plugins.dev.publication.inspect', 'plugins.dev.publication.prepare', 'plugins.dev.publish', 'plugins.dev.publication.status'] as const;
const publication = { packageName: '@acme/triage', title: 'Triage', description: 'Triage issues', version: '1.2.0', keywords: [], readme: '', changelog: '' };
const profile = { profileId: 'npm', displayName: 'npm', origin: 'https://registry.npmjs.org', scopes: [], useAsDefault: true,
    allowPrivateNetwork: false, hasCredentials: true, authenticationState: 'configured', availability: 'available', lastSuccessfulCheckAtMs: null, updatedAtMs: 1 };
const report = { status: 'prepared', projectRoot: '/project', packageName: publication.packageName, version: publication.version,
    publication, archiveIntegrity: 'sha256-reviewed', npmIntegrity: 'sha512-reviewed', archiveSizeBytes: 20,
    files: [{ path: 'package.json', sizeBytes: 20 }], diagnostics: [] };
let serverId: string;
async function activateAccount() {
    homes.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://publisher.test');
    if (!credentials) throw new Error('Expected signed-in publisher Home');
    await restoreConnectionToActiveServer(credentials);
    getStorage().getState().activateProfileScope({ serverId, accountId: 'publisher-owner' });
}
const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
function answer(actionId: typeof ids[number], result: unknown) {
    homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
        const carried = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.success ? carried.data.envelope : body);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: request.requestId,
            execution: { ok: true, result: { ok: true, kind: actionId.replaceAll('.', '_'), result } } }) };
    } });
}
beforeEach(async () => {
    daemonRequests.length = 0; daemonReply.mockReset();
    await homes.reset(); await loadSyncSingletonForTests();
    resetSessionDraftRepositoryForTests(); await prepareSessionDraftPersistenceStorage(); push.mockReset();
    serverId = await homes.addHome({ name: 'Publisher', serverUrl: 'https://publisher.test', serverIdentityId: 'srv_publisher',
        accountId: 'publisher-owner', currentAccount: true });
    const machine = createMachineFixture({ id: 'publisher-machine', activeAt: Date.now() });
    await publishMachineInventoryForTest({ serverId, accountId: 'publisher-owner' }, [machine]);
    homes.answer(serverId, '/v1/machines/publisher-machine', { body: { machine: {
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'publisher-owner', machine }),
        installationId: 'publisher-installation', installationPublicKey: encodeBase64(key.publicKey),
    } } });
    homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: Object.fromEntries(ids.map(id => [id, ['ui']])) },
    } } } });
    for (const actionId of ids) homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-test-invocation', binding: {
            accountId: 'publisher-owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_publisher',
            machineId: 'publisher-machine', installationId: 'publisher-installation', custodianAccountId: 'publisher-owner',
            accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
    } });
    answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile] });
    answer('plugins.dev.publication.prepare', report);
    modal.show.mockReset().mockReturnValue('connect');
});
afterEach(async () => { vi.unstubAllGlobals(); standardCleanup(); await disconnectActiveServerConnection(); await homes.reset(); });
const mount = (projectRoot = '/project') => renderHook(() => usePluginPublish({ projectRoot,
    initialTarget: { machineId: 'publisher-machine', serverIdentityId: 'srv_publisher' } }));

describe('mounted plugin publisher', () => {
    it.each(['ui', 'agent-declined', 'agent-approved', 'prepare-denied', 'connect-refused'] as const)('connects, selects and publishes through mounted opaque publisher commands and retires them on close: %s', async invocation => {
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(homes.request);
        await activateAccount();
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { CurrentUiContextProvider, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
        const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        const { PluginPublishScreen } = await import('./PluginPublishScreen');
        const { t } = await import('@/text');
        const credentials = (await TokenStorage.getCredentialsForServerUrl('https://publisher.test'))!;
        let reader: ReturnType<typeof useOptionalCurrentUiContextReader>;
        function Observe() { reader = useOptionalCurrentUiContextReader(); return null; }
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials,
            children: React.createElement(MainAppTabStateProvider, null, React.createElement(AppPaneProvider, null,
                React.createElement(CurrentUiContextProvider, null, React.createElement(CurrentUiContextActionHost),
                    React.createElement(Observe), React.createElement(PluginPublishScreen)))),
        }));
        const title = (key: 'connect' | 'npmProfile' | 'publicationMode' | 'prepare' | 'publish') => t(`settingsPlugins.publish.${key}`);
        const command = (key: Parameters<typeof title>[0]) => reader?.readCurrentUiContext()?.commands.find(value => value.title === title(key));
        await vi.waitFor(() => expect(command('prepare')).toBeDefined());
        expect(command('publish')).toBeUndefined();
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = (id: string, input?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) =>
            executor.execute('ui.current_context.command.invoke', { commandId: id, ...(input === undefined ? {} : { input }) }, { surface: 'ui' });
        expect(command('connect')).toBeDefined();
        let connecting: ReturnType<typeof invoke> | undefined;
        await act(async () => { connecting = invoke(command('connect')!.id); await flushHookEffects(); });
        const config = modal.show.mock.calls.at(-1)?.[0] as { props: {
            onResult: (value: unknown) => void;
            request: { onOperationError?: (code: string) => void };
        } };
        if (invocation === 'connect-refused') {
            await act(async () => {
                config.props.request.onOperationError?.('authentication_required');
                config.props.onResult({ kind: 'dismissed' });
                await connecting;
            });
            expect(screen.getTextContent()).toContain('authentication_required');
            expect(command('publish')).toBeUndefined();
            expect(command('connect')).toBeDefined();
            expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
            return;
        }
        await act(async () => { config.props.onResult({ kind: 'selected', profile }); await connecting; });
        await act(async () => { expect(await invoke(command('npmProfile')!.id, { profileId: 'npm' })).toMatchObject({ ok: true }); });
        await act(async () => { expect(await invoke(command('publicationMode')!.id, { mode: 'invalid' })).toMatchObject({ ok: false }); });
        await act(async () => { expect(await invoke(command('publicationMode')!.id, { mode: 'staged' })).toMatchObject({ ok: true }); });
        if (invocation === 'prepare-denied') {
            homes.answer(serverId, '/v1/actions/plugins.dev.publication.prepare', { select: body => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.dev.publication.prepare',
                    requestId: request.requestId, execution: { ok: false, errorCode: 'permission_denied', error: 'denied' } }) };
            } });
            await act(async () => { expect(await invoke(command('prepare')!.id)).toMatchObject({ ok: false, errorCode: 'permission_denied' }); });
            expect(command('publish')).toBeUndefined();
            expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
            expect(screen.getTextContent()).toContain('permission_denied');
            answer('plugins.dev.publication.prepare', report);
        }
        await screen.pressByTestIdAsync('plugin-publish.prepare');
        await vi.waitFor(() => expect(command('publish')).toBeDefined());
        answer('plugins.dev.publish', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        const publish = command('publish')!;
        if (invocation === 'ui' || invocation === 'prepare-denied') {
            await act(async () => { expect(await invoke(publish.id)).toMatchObject({ ok: true }); });
        } else {
            const { ApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
            const { decideApprovalRequestTransition } = await import('@happier-dev/protocol/approvals/approvalRequestTransition');
            const { createActionExecutor, buildActionExecuteResultFromRecordedApprovalExecution } = await import('@happier-dev/protocol/actions/actionExecutor');
            const { openExternalActionRequesterAccountContextV1 } = await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
            let stored: import('@happier-dev/protocol/approvals/approvalRequestV1').ApprovalRequest | null = null;
            let publications = 0;
            let boundaryFailure: unknown = null;
            // Home/Machine HTTP and approval persistence are external boundaries;
            // the remote Action admission, policy and approval transition stay real.
            const machine = createActionExecutor(createActionExecutorBoundaryFixture({
                approvalsCreate: async ({ request }) => { stored = ApprovalRequestSchema.parse(request); return { artifactId: 'publication-review' }; },
                approvalsGet: async () => stored,
                approvalsUpdate: async ({ request, expectedStatus }) => {
                    if (!stored) throw new Error('Missing publication review');
                    const next = ApprovalRequestSchema.parse(request);
                    const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
                    if (transition.ok) stored = next;
                    return transition;
                },
                isApprovalExecutionOriginCurrent: async () => true,
                pluginsDevLoopAction: async () => {
                    publications++;
                    return { ok: true, kind: 'plugins_dev_publish', result: { status: 'published',
                        packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' } };
                },
            }));
            homes.answer(serverId, '/v1/actions/plugins.dev.publish', { select: async body => {
                try {
                const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.envelope);
                const opened = openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: 'publisher-machine', installationId: 'publisher-installation',
                    serverIdentityId: 'srv_publisher', installationPrivateKey: key.secretKey, includeInvocation: true });
                expect(opened?.invocation).toMatchObject({ surface: 'agent', authority: 'account_automation', caller: { kind: 'host' } });
                const origin = opened!.invocation!;
                const proposed = await machine.execute('plugins.dev.publish', request.input, {
                    surface: origin.surface, authority: origin.authority, actionCaller: origin.caller, serverId,
                    serverIdentityId: 'srv_publisher', runtimeAccountId: 'publisher-owner', actionRequestId: request.requestId,
                });
                expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(publications).toBe(0);
                const decided = await machine.execute('approval.request.decide', { artifactId: 'publication-review',
                    decision: invocation === 'agent-approved' ? 'approve' : 'reject' },
                { surface: 'ui', authority: 'present_user', serverId, serverIdentityId: 'srv_publisher', runtimeAccountId: 'publisher-owner' });
                expect(decided).toMatchObject({ ok: true, result: { status: invocation === 'agent-approved' ? 'executed' : 'rejected' } });
                const execution = invocation === 'agent-approved' && decided.ok
                    ? buildActionExecuteResultFromRecordedApprovalExecution(ApprovalRequestSchema.parse(stored))
                    : { ok: false as const, errorCode: 'permission_denied', error: 'denied' };
                expect(execution).not.toBeNull();
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.dev.publish',
                    requestId: request.requestId, execution }) };
                } catch (cause) { boundaryFailure = cause; throw cause; }
            } });
            await act(async () => {
                const outcome = await executor.execute('ui.current_context.command.invoke', { commandId: publish.id },
                    { surface: 'agent', authority: 'account_automation', serverId,
                        actionRequestId: `publisher-command-${invocation}`, actionCaller: { kind: 'host' } });
                expect(boundaryFailure).toBeNull();
                if (invocation === 'agent-approved') expect(outcome).not.toHaveProperty('errorCode');
                expect(outcome).toMatchObject({ ok: invocation === 'agent-approved' });
            });
            expect(stored).toMatchObject({ status: invocation === 'agent-approved' ? 'executed' : 'rejected' });
            expect(publications).toBe(invocation === 'agent-approved' ? 1 : 0);
        }
        if (invocation !== 'agent-declined') {
            const input = homes.requestsFor('/v1/actions/plugins.dev.publish').at(-1)?.input;
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carried.success ? carried.data.envelope : input);
            expect(envelope.input).toMatchObject({ profileId: 'npm', mode: 'staged', access: 'public' });
        }
        await screen.unmount();
        expect(await invoke(publish.id)).toMatchObject({ ok: false });
    });
    it('surfaces a failed publication link and opens it after the client opener recovers', async () => {
        await activateAccount();
        const packageUrl = 'https://www.npmjs.com/package/@acme/triage';
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            history: { versions: [{ version: publication.version, versionUrl: packageUrl }] } });
        const { PluginPublishScreen } = await import('./PluginPublishScreen');
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderScreen(React.createElement(PluginPublishScreen));
        const version = () => screen.findAllByType(Item).find(row => row.props.title === publication.version)!;
        await vi.waitFor(() => expect(version()).toBeDefined());
        const open = vi.fn();
        vi.stubGlobal('open', undefined);
        await act(async () => { await version().props.onPress(); });
        expect(screen.getTextContent()).toContain('external_link_unavailable');
        vi.stubGlobal('open', open);
        await act(async () => { await version().props.onPress(); });
        expect(open).toHaveBeenCalledWith(packageUrl, '_blank', 'noopener,noreferrer');
        expect(screen.getTextContent()).not.toContain('external_link_unavailable');
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
        await screen.unmount();
    });
    it('opens a Bot template listing with the template identity before any Machine is inspected', async () => {
        const release: BotTemplateReleaseV1 = { v: 1, version: '1.2.0', changelog: 'First release', releasedAtMs: 123,
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Grow herbs' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
        const hook = await renderHook(() => usePluginPublish({ projectRoot: '',
            botTemplate: { draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d', expectedRevision: { headerVersion: 2, bodyVersion: 3 }, release } }));
        expect(hook.getCurrent().draft.getState().fields).toMatchObject({
            title: 'Garden', description: 'Plant care', version: '1.2.0', changelog: 'First release', push: false });
    });
    it('prepares a saved Bot template after its original Account target resolves with one version and changelog', async () => {
        const release: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: 'Seed', releasedAtMs: 123,
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Grow herbs' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
        const botTemplate = { draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d',
            expectedRevision: { headerVersion: 2, bodyVersion: 3 }, release };
        await activateAccount();
        const source = await resolveServerCredentialAccountScope(serverId);
        if (source.kind !== 'bound') throw new Error('Expected signed-in template Account');
        const hook = await renderHook(() => usePluginPublish({ projectRoot: '', botTemplate,
            sourceScope: source.scope,
            initialTarget: { machineId: 'publisher-machine', serverIdentityId: 'srv_publisher' } }));
        await vi.waitFor(() => expect(hook.getCurrent().inspection?.status).toBe('ready'));
        await act(async () => { hook.getCurrent().draft.getState().patch({ version: '2.0.0', changelog: 'More herbs' }); });
        await act(async () => { await hook.getCurrent().prepare(); });
        const prepared = ExternalActionRequestEnvelopeV1Schema.parse(homes.requestsFor('/v1/actions/plugins.dev.publication.prepare').at(-1)?.input);
        expect(prepared.input).toMatchObject({ botTemplate, publication: { version: '2.0.0', changelog: 'More herbs' } });
        expect(prepared.input).not.toHaveProperty('projectRoot');
        expect(homes.requestsFor('/v1/actions/plugins.dev.publication.inspect')).toHaveLength(1);
        expect(homes.requestsFor('/v1/actions/template.release')).toHaveLength(0);
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
    });
    it('reuses the known template timestamp across publisher mounts and keeps a fresh timestamp for an edited version', async () => {
        const previousRelease: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: 'Seed', releasedAtMs: 123,
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Grow herbs' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
        const existingPublication = { ...publication, version: previousRelease.version, changelog: previousRelease.changelog };
        answer('plugins.dev.publication.inspect', { status: 'ready', publication: existingPublication, profiles: [profile] });
        answer('plugins.dev.publication.prepare', { ...report, version: existingPublication.version, publication: existingPublication });
        await activateAccount();
        const source = await resolveServerCredentialAccountScope(serverId);
        if (source.kind !== 'bound') throw new Error('Expected signed-in template Account');
        const mountTemplate = (releasedAtMs: number) => renderHook(() => usePluginPublish({ projectRoot: '',
            botTemplate: { draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d',
                expectedRevision: { headerVersion: 2, bodyVersion: 3 }, release: { ...previousRelease, releasedAtMs } },
            previousRelease, sourceScope: source.scope,
            initialTarget: { machineId: 'publisher-machine', serverIdentityId: 'srv_publisher' } }));
        const preparedInput = () => ExternalActionRequestEnvelopeV1Schema.parse(
            homes.requestsFor('/v1/actions/plugins.dev.publication.prepare').at(-1)?.input).input;
        const first = await mountTemplate(456);
        await vi.waitFor(() => expect(first.getCurrent().inspection?.status).toBe('ready'));
        await act(async () => { await first.getCurrent().prepare(); });
        expect(preparedInput()).toMatchObject({ botTemplate: { release: previousRelease }, publication: { version: '1.0.0' } });
        await act(async () => { first.getCurrent().draft.getState().patch({ version: '2.0.0', changelog: 'More herbs' }); });
        await act(async () => { await first.getCurrent().prepare(); });
        expect(preparedInput()).toMatchObject({ botTemplate: { release: { ...previousRelease, releasedAtMs: 456 } },
            publication: { version: '2.0.0', changelog: 'More herbs' } });
        await first.unmount();
        const reopened = await mountTemplate(789);
        await vi.waitFor(() => expect(reopened.getCurrent().inspection?.status).toBe('ready'));
        await act(async () => { await reopened.getCurrent().prepare(); });
        expect(preparedInput()).toMatchObject({ botTemplate: { release: previousRelease }, publication: { version: '1.0.0' } });
        expect(homes.requestsFor('/v1/actions/template.release')).toHaveLength(0);
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
    });
    it('publishes a rootless Bot package with a deliberately selected GitHub release repository', async () => {
        const release: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: 'Seed', releasedAtMs: 123,
            content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Grow herbs' },
                memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
        const botTemplate = { draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d',
            expectedRevision: { headerVersion: 2, bodyVersion: 3 }, release };
        const selected = { ...publication, version: '2.0.0', changelog: 'More herbs' };
        const { projectRoot: _root, ...rootlessReport } = report;
        answer('plugins.dev.publication.inspect', { status: 'ready', publication: selected, profiles: [profile] });
        answer('plugins.dev.publication.prepare', { ...rootlessReport, version: selected.version, publication: selected });
        answer('plugins.dev.publish', { status: 'published', packageName: selected.packageName, version: selected.version,
            registryOrigin: profile.origin });
        const hook = await renderHook(() => usePluginPublish({ projectRoot: '', botTemplate,
            initialTarget: { machineId: 'publisher-machine', serverIdentityId: 'srv_publisher' } }));
        await vi.waitFor(() => expect(hook.getCurrent().inspection?.status).toBe('ready'));
        await act(async () => { await hook.getCurrent().selectProfile(profile.profileId); });
        await act(async () => { hook.getCurrent().draft.getState().patch({ github: true, push: false, release: true,
            repository: 'acme/bots', repositoryDeployment: 'https://github.com', branch: 'main' }); });
        await act(async () => { await hook.getCurrent().prepare(); });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        await vi.waitFor(() => expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1));
        const submitted = ExternalActionRequestEnvelopeV1Schema.parse(homes.requestsFor('/v1/actions/plugins.dev.publish')[0]?.input);
        expect(submitted.input).toMatchObject({ botTemplate, publication: selected,
            github: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/bots' },
                release: { tagName: 'v2.0.0', body: 'More herbs' } } });
        expect(submitted.input).not.toHaveProperty('projectRoot');
        expect(submitted.input).not.toHaveProperty('github.source');
    });
    it('renders a source-preserving scaffold handoff and keeps publication disabled for an unprepared source', async () => {
        await activateAccount();
        answer('plugins.dev.publication.inspect', { status: 'failed', diagnostics: [{ code: 'publication_scaffold_required', message: 'Source needs a package' }],
            scaffold: { sourceRootPath: '/plugins/source.ts', sessionDirectory: '/plugins' } });
        const { PluginPublishScreen } = await import('./PluginPublishScreen');
        const screen = await renderScreen(React.createElement(PluginPublishScreen));
        expect(screen.findByTestId('plugin-publish.submit')?.props.disabled).toBe(true);
        expect(screen.findByTestId('plugin-publish.scaffold')).not.toBeNull();
        await screen.pressByTestIdAsync('plugin-publish.scaffold');
        await vi.waitFor(() => expect(push).toHaveBeenCalled());
        const navigation = push.mock.calls.at(-1)?.[0] as { pathname: string; params: { draftId: string } };
        expect(navigation.pathname).toBe('/new');
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'publisher-owner' }, draftId: navigation.params.draftId }))
            .toMatchObject({ input: expect.stringContaining('/plugins/source.ts'), selectedPath: '/plugins',
                executionTarget: { kind: 'machine', target: { serverId, machineId: 'publisher-machine' } } });
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
    });
    it('keeps a known Action refusal retryable without claiming an uncertain npm upload', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.dev.publish', requestId: request.requestId,
                execution: { ok: false, errorCode: 'access_denied', error: 'access_denied', effectAttempted: false } }) };
        } });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(hook.getCurrent().result?.status).toBe('failed');
        expect(hook.getCurrent().attempt?.integrity).toBeUndefined();
        expect(hook.getCurrent().canPublish).toBe(true);
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1);
    });
    it('retains read-only recovery for a malformed publication receipt after transport issuance', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { body: { malformed: true } });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(hook.getCurrent().result?.status).toBe('outcome_unknown');
        expect(hook.getCurrent().attempt?.integrity).toBe('sha512-reviewed');
        expect(hook.getCurrent().canPublish).toBe(false);
    });
    it('keeps an authenticated pre-open refusal retryable even after issuing its HTTP request', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        const refusal = projectExternalActionHttpError('credential_scope_denied');
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { status: refusal.statusCode, body: refusal.payload });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(hook.getCurrent().result).toMatchObject({ status: 'failed', code: 'credential_scope_denied' });
        expect(hook.getCurrent().attempt?.integrity).toBeUndefined();
        expect(hook.getCurrent().canPublish).toBe(true);
    });
    it('retains repository attachment on retry and reviews the newly selected unused remote', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        const target = ScmHostingRepositoryPublishTargetSchema.parse({
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            owner: 'acme', ownerKind: 'org', label: 'Acme', supportedVisibilities: ['public'], supportedRemoteUrlKinds: ['https'],
        });
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            github: { status: 'ready', branch: 'main', remote: 'origin', publishTargets: { success: true,
                auth: { state: 'authenticated', profileKind: 'provider_cli' }, defaultRepositoryName: 'triage', targets: [target] } } });
        await act(async () => { await hook.getCurrent().inspect(undefined, true);
            hook.getCurrent().draft.getState().patch({ github: true, createRepository: true, githubOwner: githubPublicationTargetId(target) }); });
        answer('plugins.dev.publish', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed',
            github: { status: 'partial', phase: 'repository', pushed: false, repositoryUrl: 'https://github.com/acme/triage', errorCode: 'REMOTE_ALREADY_EXISTS' } });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        await act(async () => { hook.getCurrent().draft.getState().patch({ remote: 'published' }); await hook.getCurrent().retryGithub(); });
        const requests = homes.requestsFor('/v1/actions/plugins.dev.publish');
        expect(requests).toHaveLength(2);
        expect(ExternalActionRequestEnvelopeV1Schema.parse(requests[1]?.input).input).toMatchObject({ githubOnly: true,
            github: { createRepository: { remoteName: 'published' }, source: { remote: 'published' } } });
        const refusal = projectExternalActionHttpError('credential_scope_denied');
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { status: refusal.statusCode, body: refusal.payload });
        await act(async () => { await hook.getCurrent().retryGithub(); });
        expect(hook.getCurrent().published?.status).toBe('published');
        expect(hook.getCurrent().canPublish).toBe(false);
        expect(hook.getCurrent().result).toMatchObject({ status: 'published', github: { status: 'partial', phase: 'repository' } });
        await act(async () => { await hook.getCurrent().retryGithub(); });
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(4);
    });
    it('keeps publication recovery scoped to the selected registry origin', async () => {
        const sameRegistry = { ...profile, profileId: 'same-registry' };
        const anotherRegistry = { ...profile, profileId: 'another-registry', origin: 'https://npm.example.test' };
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile, sameRegistry, anotherRegistry] });
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        answer('plugins.dev.publish', { status: 'published', packageName: publication.packageName, version: publication.version,
            integrity: 'sha512-reviewed', registryOrigin: profile.origin });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        await act(async () => { await hook.getCurrent().selectProfile(sameRegistry.profileId); });
        expect(hook.getCurrent().canPublish).toBe(false);
        await act(async () => { await hook.getCurrent().selectProfile(anotherRegistry.profileId); });
        expect(hook.getCurrent().canPublish).toBe(true);
    });
    it('requires provider review when publication cancellation leaves GitHub effects unconfirmed', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            github: { status: 'ready', repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/triage' }, branch: 'main', remote: 'origin' } });
        await act(async () => { await hook.getCurrent().inspect(undefined, true); hook.getCurrent().draft.getState().patch({ github: true }); });
        const response = createDeferred<{ body: unknown }>();
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { select: async () => response.promise });
        let publishing!: ReturnType<PluginPublishController['publishSelected']>;
        await act(async () => { publishing = hook.getCurrent().publishSelected(); });
        await act(async () => { hook.getCurrent().cancel(); });
        response.reject(new Error('aborted transport'));
        await act(async () => { await publishing; });
        answer('plugins.dev.publication.status', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        await act(async () => { await hook.getCurrent().checkPublication(); });
        expect(hook.getCurrent().canContinueGithub).toBe(false);
        expect(hook.getCurrent().attempt?.githubOutcomeUnconfirmed).toBe(true);
        await act(async () => { await hook.getCurrent().retryGithub(); });
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1);
    });
    it('reads GitHub history only on request and surfaces an unavailable contributed reader', async () => {
        const hook = await mount();
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            github: { status: 'ready', repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/triage' } } });
        await act(async () => { await hook.getCurrent().inspect(undefined, true); });
        expect(hook.getCurrent().githubHistory).toBeNull();
        await act(async () => { await hook.getCurrent().readGithubHistory(); });
        expect(hook.getCurrent().githubHistory?.kind).toBe('unavailable');
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(0);
    });
    it('reads and pages canonical GitHub releases through the selected Machine contributed Action', async () => {
        await activateAccount();
        const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/triage' };
        const action: PluginUiActionProjection = {
            ...PluginProjectedActionV2Schema.parse({ id: 'github/releases/list', pluginId: 'happier.scm.forge.github',
                occurrenceId: 'publisher-releases-current', title: 'Releases', scopes: ['global'], surfaces: ['ui'],
                execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }),
            [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: { machineId: 'publisher-machine', serverId,
                interactionEnabled: true, phase: 'current', executionOrigin: { serverIdentityId: 'srv_publisher',
                    materializationRef: { pluginId: 'happier.scm.forge.github', machineId: 'publisher-machine', materializationId: 'publisher-github' } } },
        };
        const unpublish = publishCommittedAppShellPluginUiProjection(read => read && areServerProfileIdentifiersEquivalent(read.scope.serverId, serverId)
            && read.scope.accountId === 'publisher-owner' ? { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 27,
                actionsById: { 'happier.scm.forge.github/github/releases/list': action } } : null);
        const first = createForgeReleaseV1Fixture({ repository, releaseId: '1', tagName: 'v1', draft: false });
        const second = createForgeReleaseV1Fixture({ repository, releaseId: '2', tagName: 'v2', draft: false });
        daemonReply.mockImplementation(request => {
            if (request.method === `publisher-machine:${RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ}`) return {
                ok: true, inputSchema: ForgeReleaseActionInputSchemasV1.listReleases.jsonSchema,
                outputSchema: ForgeReleaseActionResultSchemasV1.listReleases.jsonSchema,
            };
            if (request.method !== `publisher-machine:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`) return undefined;
            const payload = request.params;
            if (!payload || typeof payload !== 'object' || !('input' in payload)) throw new Error('Expected contributed release input');
            const input = ForgeReleaseActionInputSchemasV1.listReleases.parse(payload.input);
            expect(input.repository).toEqual(repository);
            return { ok: true, result: ForgeReleaseActionResultSchemasV1.listReleases.parse({ kind: 'value', value: {
                rows: [input.cursor ? second : first], omittedRowCount: input.cursor ? 0 : 1,
                projectionTruncated: !input.cursor, continuation: input.cursor ? null : 'next-releases',
                incomplete: input.cursor ? null : 'pagination',
            } }) };
        });
        try {
            const hook = await mount();
            answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
                github: { status: 'ready', repository } });
            await act(async () => { await hook.getCurrent().inspect(undefined, true); });
            expect(daemonRequests).toHaveLength(0);
            await act(async () => { await hook.getCurrent().readGithubHistory(); });
            expect(hook.getCurrent().githubHistory).toMatchObject({ kind: 'ready', rows: [first],
                continuation: 'next-releases', canLoadMore: true, omittedRowCount: 1, projectionTruncated: true, incomplete: 'pagination' });
            await act(async () => { await hook.getCurrent().readGithubHistory('next-releases'); });
            expect(hook.getCurrent().githubHistory).toMatchObject({ kind: 'ready', rows: [first, second],
                continuation: null, canLoadMore: false, omittedRowCount: 1, projectionTruncated: true });
            const executions = daemonRequests.filter(request => request.method.endsWith(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE));
            expect(executions.map(request => request.params)).toEqual([
                expect.objectContaining({ input: { repository }, executionSurface: 'ui', expectedContributorOccurrenceId: 'publisher-releases-current' }),
                expect.objectContaining({ input: { repository, cursor: 'next-releases' }, executionSurface: 'ui', expectedContributorOccurrenceId: 'publisher-releases-current' }),
            ]);
        } finally { unpublish(); }
    });
    it('continues selected GitHub effects only after a staged version is explicitly proven public', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); hook.getCurrent().setMode('staged'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            github: { status: 'ready', repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/triage' }, branch: 'main', remote: 'origin' } });
        await act(async () => { await hook.getCurrent().inspect(undefined, true); hook.getCurrent().draft.getState().patch({ github: true }); });
        answer('plugins.dev.publish', { status: 'awaiting_maintainer', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(hook.getCurrent().canContinueGithub).toBe(false);
        answer('plugins.dev.publication.status', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        await act(async () => { await hook.getCurrent().checkPublication(); });
        expect(hook.getCurrent().canContinueGithub).toBe(true);
        answer('plugins.dev.publish', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed',
            github: { status: 'published', phase: 'release', pushed: true } });
        await act(async () => { await hook.getCurrent().retryGithub(); });
        const requests = homes.requestsFor('/v1/actions/plugins.dev.publish');
        expect(requests).toHaveLength(2);
        expect(ExternalActionRequestEnvelopeV1Schema.parse(requests[1]?.input).input).toMatchObject({ githubOnly: true, expectedArchiveIntegrity: 'sha256-reviewed' });
    });
    it('keeps keystrokes local and preserves edits while private Connect is open', async () => {
        const hook = await mount('/project/source.ts');
        expect(hook.getCurrent().inspection?.status).toBe('ready');
        const initialReads = homes.requestsFor('/v1/actions/plugins.dev.publication.inspect').length;
        let connect!: ReturnType<PluginPublishController['connect']>;
        await act(async () => { connect = hook.getCurrent().connect(); });
        const config = modal.show.mock.calls.at(-1)?.[0] as { props: { request: { projectDir?: string }; onResult: (value: unknown) => void } };
        expect(config.props.request.projectDir).toBe('/project');
        await act(async () => {
            hook.getCurrent().draft.getState().patch({ title: 'Edited while signing in' });
            config.props.onResult({ kind: 'selected', profile }); await connect;
        });
        expect(hook.getCurrent().draft.getState().fields.title).toBe('Edited while signing in');
        expect(hook.getCurrent().profile?.profileId).toBe('npm');
        expect(homes.requestsFor('/v1/actions/plugins.dev.publication.inspect')).toHaveLength(initialReads + 1);
        expect(ExternalActionRequestEnvelopeV1Schema.parse(homes.requestsFor('/v1/actions/plugins.dev.publication.inspect').at(-1)?.input).input)
            .toMatchObject({ profileId: 'npm', packageName: '@acme/triage' });
        await act(async () => { await hook.getCurrent().prepare(); });
        expect(ExternalActionRequestEnvelopeV1Schema.parse(homes.requestsFor('/v1/actions/plugins.dev.publication.prepare').at(-1)?.input).input)
            .toMatchObject({ projectRoot: '/project' });
        answer('plugins.dev.publish', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(ExternalActionRequestEnvelopeV1Schema.parse(homes.requestsFor('/v1/actions/plugins.dev.publish').at(-1)?.input).input)
            .toMatchObject({ projectRoot: '/project' });
    });

    it('retains exact-version recovery after cancelling a publication with no terminal reply', async () => {
        const hook = await mount();
        await act(async () => { await hook.getCurrent().selectProfile('npm'); });
        await act(async () => { await hook.getCurrent().prepare(); });
        expect(hook.getCurrent().preparation?.archiveIntegrity).toBe('sha256-reviewed');
        const response = createDeferred<{ body: unknown }>();
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { select: async () => response.promise });
        let publishing!: ReturnType<PluginPublishController['publishSelected']>;
        await act(async () => { publishing = hook.getCurrent().publishSelected(); });
        expect(hook.getCurrent().attempt?.integrity).toBe('sha512-reviewed');
        await act(async () => { hook.getCurrent().cancel(); });
        // The network adapter has no response: cancellation must expose read-only recovery.
        response.reject(new Error('aborted transport'));
        await act(async () => { await publishing; });
        expect(hook.getCurrent().result?.status).toBe('outcome_unknown');
        await act(async () => { await hook.getCurrent().publishSelected(); });
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1);
        answer('plugins.dev.publication.status', { status: 'published', packageName: publication.packageName, version: publication.version, integrity: 'sha512-reviewed' });
        await act(async () => {
            hook.getCurrent().draft.getState().patch({ packageName: '@acme/another-package', version: '2.0.0' });
            await hook.getCurrent().checkPublication();
        });
        expect(hook.getCurrent().result?.status).toBe('published');
        const request = homes.requestsFor('/v1/actions/plugins.dev.publication.status').at(-1);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request?.input);
        expect(envelope.input).toMatchObject({ packageName: '@acme/triage', version: '1.2.0', integrity: 'sha512-reviewed' });
        await flushHookEffects();
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1);
    });

    it('says why Publish is off, holds the draft while publishing and corrects an occupied version at its field', async () => {
        await activateAccount();
        answer('plugins.dev.publication.inspect', { status: 'ready', projectRoot: '/project', publication, profiles: [profile],
            nextVersions: { patch: '1.2.1', minor: '1.3.0', major: '2.0.0' } });
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { CurrentUiContextProvider, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
        const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        const { PluginPublishScreen } = await import('./PluginPublishScreen');
        const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
        const { t } = await import('@/text');
        const credentials = (await TokenStorage.getCredentialsForServerUrl('https://publisher.test'))!;
        let reader: ReturnType<typeof useOptionalCurrentUiContextReader>;
        function Observe() { reader = useOptionalCurrentUiContextReader(); return null; }
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials,
            children: React.createElement(MainAppTabStateProvider, null, React.createElement(AppPaneProvider, null,
                React.createElement(CurrentUiContextProvider, null, React.createElement(CurrentUiContextActionHost),
                    React.createElement(Observe), React.createElement(PluginPublishScreen)))),
        }));
        const copy = (key: 'npmProfile' | 'prepare' | 'publish' | 'patchDraft' | 'signInToPublish' | 'versionTakenReason' | 'versionConflict' | 'prepareRequired') =>
            t(`settingsPlugins.publish.${key}`);
        const command = (key: Parameters<typeof copy>[0]) => reader?.readCurrentUiContext()?.commands.find(value => value.title === copy(key));
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = (id: string, input?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) =>
            executor.execute('ui.current_context.command.invoke', { commandId: id, ...(input === undefined ? {} : { input }) }, { surface: 'agent' });
        const versionField = () => screen.findAllByType(FieldTextInput).find(field => field.props.testID === 'plugin-publish.field.version')!;
        await vi.waitFor(() => expect(command('prepare')).toBeDefined());
        // No profile yet: the footer states the one reason Publish is off.
        expect(screen.getTextContent()).toContain(copy('signInToPublish'));
        await act(async () => { expect(await invoke(command('npmProfile')!.id, { profileId: 'npm' })).toMatchObject({ ok: true }); });
        expect(screen.getTextContent()).not.toContain(copy('signInToPublish'));
        await screen.pressByTestIdAsync('plugin-publish.prepare');
        await vi.waitFor(() => expect(command('publish')).toBeDefined());

        const response = createDeferred<{ body: unknown }>();
        homes.answer(serverId, '/v1/actions/plugins.dev.publish', { select: async body => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const request = ExternalActionRequestEnvelopeV1Schema.parse(carried.success ? carried.data.envelope : body);
            await response.promise;
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'plugins.dev.publish', requestId: request.requestId,
                execution: { ok: true, result: { ok: true, kind: 'plugins_dev_publish', result: { status: 'version_conflict',
                    packageName: publication.packageName, version: publication.version } } } }) };
        } });
        await act(async () => { screen.findByTestId('plugin-publish.submit')!.props.onPress(); await flushHookEffects(); });
        // While the publication is pending the person and the agent both see a read-only draft.
        expect(versionField().props.editable).toBe(false);
        await act(async () => { expect(await invoke(command('patchDraft')!.id, { version: '9.9.9' })).toMatchObject({ ok: false }); });
        await act(async () => { response.resolve({ body: null }); await flushHookEffects(); });
        await vi.waitFor(() => expect(versionField().props.editable).not.toBe(false));

        // The occupied version is corrected at its own field with the inspected next version.
        expect(versionField().props.error).toBe(copy('versionConflict'));
        expect(screen.getTextContent()).toContain(copy('versionTakenReason'));
        expect(screen.findByTestId('plugin-publish.submit')!.props.disabled).toBe(true);
        expect(command('publish')).toBeUndefined();
        await screen.pressByTestIdAsync('plugin-publish.version.next');
        expect(versionField().props.value).toBe('1.2.1');
        expect(versionField().props.error ?? null).toBeNull();
        expect(screen.getTextContent()).toContain(copy('prepareRequired'));
        expect(homes.requestsFor('/v1/actions/plugins.dev.publish')).toHaveLength(1);
        await screen.unmount();
    });
});
