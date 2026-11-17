import * as React from 'react';
import * as ReactNative from 'react-native';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { BotTemplateReleaseV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { BotTemplateRecipientScreen } from './BotTemplateRecipientScreen';
import BotTemplateCopyForm from './BotTemplateCopyForm';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { act } from 'react-test-renderer';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { NewSessionEmbeddedHostProvider, type NewSessionEmbeddedHost } from '@/components/sessions/new/navigation/newSessionHost';
import { NewBotDraftFace } from '@/components/sessions/bots/NewBotDraftHeader';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/bots/templates/phone-template' }).module);
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    useIsFocused: () => true,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
}));

await loadSyncSingletonForTests();

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let commandReader: CurrentUiContextReader | null = null;
let unregisterCommands: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    unregisterCommands?.(); unregisterCommands = undefined; commandReader = null;
    await home?.dispose(); home = undefined;
});

function PublishRecipientCommands() {
    commandReader = useOptionalCurrentUiContextReader();
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    React.useEffect(() => {
        if (!commandReader) return;
        const reader = commandReader;
        unregisterCommands = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregisterCommands;
    }, []);
    return null;
}

describe('recipient template page', () => {
    it('reopens one template draft with the edited identity and creation choices intact', async () => {
        const recipe = { pluginId: 'com.example.tools', recipeId: 'git', revision: '1' };
        const hydratedMachine = createMachineFixture({ id: 'garden-machine', activeAt: Date.now(), daemonState: {
                setup: MachineSetupObservationV1Schema.parse({ version: 1, desiredRevision: 0, status: 'satisfied',
                    recipes: [{ ref: recipe, status: 'satisfied', steps: [{ stepId: 'git', status: 'satisfied',
                        packages: [{ manager: 'apt', name: 'git', present: true, version: '2.47.1' }] }] }] }),
            } });
        const machine = createPlainMachineRowFixture({ id: 'garden-machine', accountId: 'artifact-account', machine: hydratedMachine });
        home = await createPlainArtifactHomeFixture('https://template-draft-reopen.test', { currentAccount: true,
            handleRequest: async (path, init) => {
                if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
                if (path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (path === '/v1/machines') return Response.json([machine]);
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                    machineId => machineId === machine.id ? machine : null);
                if (path === '/v1/machines/garden-machine') return Response.json({ machine });
                return null;
            } });
        storage.setState({ isSessionDraftsReady: true });
        storage.getState().applyMachines([hydratedMachine], false, { sourceServerId: home.home.id });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
                suggestedAgent: { agentId: 'codex' },
                skills: [], memoryRules: [], needs: { software: [{ key: 'git', name: 'Git', recipe,
                    requirement: 'optional', purpose: 'Read history', skipConsequence: 'History is unavailable' }],
                    connectedAccounts: [], mcpServers: [] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        home.boundary.replaceStoredRow({ id: 'reopen-template', ownerAccountId: 'artifact-account', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const scope = { serverId: home.home.id, accountId: 'artifact-account' };
        const { listNewSessionDraftProjections, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const before = new Set(listNewSessionDraftProjections(scope).map(draft => draft.draftId));
        const createdDrafts = () => listNewSessionDraftProjections(scope).filter(draft => !before.has(draft.draftId));
        const tree = (mount: number) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><BotTemplateRecipientScreen key={mount}
                source={{ kind: 'artifact', serverId: home!.home.id, artifactId: 'reopen-template' }} serverId={home!.home.id} />
            </AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(0));
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-make-own')).not.toBeNull());
        await screen.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-copy-name')).not.toBeNull());
        expect(screen.findByTestId('bot-template-need:software:git')).toBeNull();
        expect(createdDrafts()).toHaveLength(1);
        const draftId = createdDrafts()[0]!.draftId;
        // The template's suggested Agent is the copy's starting choice (REAL-USER-PASS F5), and the copy's own name and
        // face lead the setup as "Your copy".
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.agentTarget).toMatchObject({ kind: 'agent', identity: { localId: 'codex' } });
        expect(screen.findByTestId('bot-template-your-copy')).not.toBeNull();
        await act(async () => { screen.changeTextByTestId('bot-template-copy-name', 'My herb keeper'); });
        // Create is blocked in this harness (no Agent credentials), so the footer says why instead of what Create would do.
        expect(screen.findByTestId('bot-template-create-reason')).not.toBeNull();
        await screen.pressByTestIdAsync('bot-template-cancel');
        expect(screen.findByTestId('bot-template-make-own')).not.toBeNull();
        await screen.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-copy-name')).not.toBeNull());
        expect(createdDrafts()).toHaveLength(1);
        expect(screen.findByTestId('bot-template-copy-name')!.props.value).toBe('My herb keeper');
        // Apply the external draft edit between mounts, after the old composer
        // has finished its authoring writes.
        await screen.unmount();
        const authored = { ...readNewSessionDraftFromRepository({ scope, draftId })!, selectedMachineId: machine.id,
            targetServerId: scope.serverId, executionTarget: { kind: 'machine' as const, target: { serverId: scope.serverId, machineId: machine.id } },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            // The authoring adapter binds model selection to the chosen Agent.
            modelSelection: null,
            permissionMode: 'safe-yolo' as const };
        await act(async () => { writeNewSessionDraftToRepository({ scope, draftId, draft: authored }); });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.permissionMode).toBe('safe-yolo');
        const reloaded = await renderScreen(tree(1));
        await vi.waitFor(() => expect(reloaded.findByTestId('bot-template-make-own')).not.toBeNull());
        await reloaded.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(reloaded.findByTestId('bot-template-copy-name')).not.toBeNull());
        expect(createdDrafts()).toHaveLength(1);
        expect(reloaded.findByTestId('bot-template-copy-name')!.props.value).toBe('My herb keeper');
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ sessionName: 'My herb keeper',
            selectedMachineId: machine.id, agentTarget: authored.agentTarget, permissionMode: 'safe-yolo' });
        expect(storage.getState().machines[machine.id]?.daemonState?.setup).toMatchObject({ status: 'satisfied' });
        await vi.waitFor(() => expect(reloaded.getTextContent()).toContain('2.47.1'));
        const { captureNewSessionDraftLaunchCurrentness, clearCapturedNewSessionDraftAfterLaunch } = await import('@/components/sessions/new/modules/newSessionDraftLifecycle');
        // Simulate a completed launch after leaving the composer; the mounted
        // composer would otherwise remain an active writer of this draft.
        await reloaded.unmount();
        await act(async () => {
            captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'first-template-create' });
            await clearCapturedNewSessionDraftAfterLaunch({ scope, draftId, launchUserAttemptId: 'first-template-create' });
        });
        const reopened = await renderScreen(tree(2));
        await vi.waitFor(() => expect(reopened.findByTestId('bot-template-make-own')).not.toBeNull());
        await reopened.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(reopened.findByTestId('bot-template-copy-name')).not.toBeNull());
        expect(createdDrafts()).toHaveLength(1);
        await vi.waitFor(() => expect(reopened.findByTestId('bot-template-copy-name')!.props.value).toBe('Garden'));
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.localSupplement.launchUserAttemptId).toBeUndefined();
        await reopened.unmount();
    });
    it('shares the mounted setup selections between visible controls and Agent read and patch', async () => {
        let sessionBirthRequested = false;
        let bornMetadata: unknown;
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor: { serverUrl: 'https://template-setup-draft.test',
            homeServerIdentityId: 'srv_template_setup', displayName: 'Setup' }, source: 'manual', suggestedName: 'Setup' });
        const machine = { ...createPlainMachineRowFixture({ id: 'selected-machine', accountId: 'artifact-account' }),
            installationId: 'selected-machine-installation' };
        const features = createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } },
            capabilities: { serverIdentity: { serverIdentityId: 'srv_template_setup' } } });
        home = await createPlainArtifactHomeFixture('https://template-setup-draft.test', { currentAccount: true,
            serverFeatures: features,
            handleRequest: async (path, init) => {
                if (path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
                if (path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (path === '/v1/machines') return Response.json([machine]);
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                    machineId => machineId === machine.id ? machine : null);
                if (path === '/v1/machines/selected-machine') return Response.json({ machine });
                // Requester-local template creation reaches the ordinary Session
                // birth owner; it does not mint a template root authorization.
                if (path !== '/v1/sessions') return null;
                sessionBirthRequested = true;
                bornMetadata = JSON.parse(JSON.parse(String(init?.body)).sharedMetadata.ciphertext);
                const refusal = projectExternalActionHttpError('credential_scope_denied', 'setup-copy');
                return Response.json(refusal.payload, { status: refusal.statusCode });
            } });
        storage.setState({ isSessionDraftsReady: true });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice', face: { seed: 'template-face', body: 'tall' } }, instructions: { markdown: 'Grow herbs' },
                skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [{
                    key: 'search', name: 'Search', requirement: 'optional', purpose: 'Find plants', skipConsequence: 'No search',
                    definition: { name: 'search', transport: 'stdio', stdio: { command: { kind: 'literal', value: 'search-mcp' }, args: [] },
                        env: { INDEX: { kind: 'input', key: 'index' } }, inputs: [{ key: 'index', label: 'Index', purpose: 'Choose index', secret: false, required: true }] },
                }] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        home.boundary.replaceStoredRow({ id: 'setup-template', ownerAccountId: 'artifact-account', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const authority = captureActiveServerAccountScopeLifetime();
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <PublishRecipientCommands /><BotTemplateRecipientScreen source={{ kind: 'artifact', serverId: home.home.id,
                            artifactId: 'setup-template' }} serverId={home.home.id} />
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-make-own'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-mcp-search-index')).not.toBeNull());
        const commands = commandReader!.readCurrentUiContext()!.commands;
        const read = commands.find(command => command.description === JSON.stringify({ draft: 'setup', operation: 'read' }));
        expect(read).toBeDefined();
        const patch = commands.find(command => command.id !== read!.id && command.description?.includes('"selections"'))!;
        const invokeRead = () => executor.execute('ui.current_context.command.invoke', { commandId: read!.id }, { surface: 'agent' });
        await act(async () => { screen.changeTextByTestId('bot-template-mcp-search-index', 'herbs'); });
        const uiEditedRead = await invokeRead();
        expect(uiEditedRead).toMatchObject({ ok: true, result: { selections: { mcpServers: [{ key: 'search',
            selection: { action: 'bind', inputKeys: ['index'] } }] } } });
        expect(JSON.stringify(uiEditedRead)).not.toContain('herbs');
        const selections = { software: [], accounts: [], mcpServers: [{ key: 'search', selection: { action: 'bind',
            inputs: { index: { t: 'literal', v: 'trees' } } } }] };
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: patch.id,
            input: { selections } }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId('bot-template-mcp-search-index')!.props.value).toBe('trees');
        const agentEditedRead = await invokeRead();
        expect(agentEditedRead).toMatchObject({ ok: true, result: { source: { kind: 'artifact', serverId: home.home.id,
            artifactId: 'setup-template' }, expectedVersion: '1.0.0', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
            selections: { software: [], accounts: [], mcpServers: [{ key: 'search',
                selection: { action: 'bind', inputKeys: ['index'] } }] } } });
        expect(JSON.stringify(agentEditedRead)).not.toContain('trees');
        expect(screen.findByType(NewBotDraftFace).props.face).toMatchObject({ seed: 'template-face', body: 'tall' });
        onTestFinished(withPopoverWebGlobals());
        await screen.pressByTestIdAsync('new-bot-draft-face-button');
        await screen.pressByTestIdAsync('bot-face-use-default');
        // Exercise the typed creation port that the real NewSession model consumes, stopping at the Home boundary.
        const host: NewSessionEmbeddedHost = screen.findByType(NewSessionEmbeddedHostProvider).props.host;
        const draftId = host.params.draftId;
        if (typeof draftId !== 'string') throw new Error('Missing template copy draft id');
        expect(screen.findByType(NewBotDraftFace).props.face).toEqual({ seed: draftId });
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { withNewBotDraftFaceSeed } = await import('@/components/sessions/bots/newBotDraft');
        const copyProps: React.ComponentProps<typeof BotTemplateCopyForm> = screen.findByType<typeof BotTemplateCopyForm>(BotTemplateCopyForm).props;
        const copyScope = copyProps.execution.binding?.scope;
        if (!copyScope) throw new Error('Missing template copy Account scope');
        const draft = readNewSessionDraftFromRepository({ scope: copyScope, draftId });
        if (!draft) throw new Error('Missing template copy draft');
        const creation = { creationKey: SessionCreationKeyV1Schema.parse('setup-copy'), executionTarget: { serverId: home.home.id, machineId: 'selected-machine' },
            directory: { kind: 'managed' as const }, agentTarget: { kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, permissionMode: 'default' as const, title: 'My Garden',
            identity: withNewBotDraftFaceSeed(draft.initialSessionFacts, draftId) };
        let result: unknown;
        await act(async () => {
            result = await host.executeSpawnAction!(creation, { surface: 'ui', authority: 'present_user',
                serverId: home!.home.id, actionRequestId: 'setup-copy' });
        });
        expect(sessionBirthRequested, JSON.stringify(result)).toBe(true);
        expect(bornMetadata).toMatchObject({ bot: { kind: 'bot' } });
        expect(bornMetadata).toHaveProperty('botFace', { seed: draftId });
        // The ordinary Session HTTP refusal is this fixture's stopping point.
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: 'credential_scope_denied',
            failureCause: { httpStatus: 403 } });
        expect(home.boundary.list()).toHaveLength(1);
        await screen.unmount();
    });
    it('shows the admitted release owner and sharing in preview and copy controls without creating a copy or reading inventories', async () => {
        home = await createPlainArtifactHomeFixture('https://template-recipient.test', { currentAccount: true,
            handleRequest: async path => path === '/v2/account/session-drafts/read' ? Response.json({ status: 'absent' }) : null });
        // This route opens inside an authenticated app whose empty draft collection is already hydrated.
        storage.setState({ isSessionDraftsReady: true });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
                skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [{ key: 'issues', name: 'Issues',
                    serviceId: 'happier.service.github/github', requirement: 'required', purpose: 'Read repository issues',
                    skipConsequence: 'Cannot read issues' }], mcpServers: [] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        home.boundary.replaceStoredRow({ id: 'released-template', ownerAccountId: 'artifact-account', ownerDisplayName: 'Maya Rowan', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        home.boundary.seedAccountGrant('released-template', 'recipient-account', 'view');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BotTemplateRecipientScreen source={{ kind: 'artifact', serverId: home.home.id,
            artifactId: 'released-template' }} serverId={home.home.id} /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-instructions-disclosure')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('Grow herbs');
        await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
        expect(screen.getTextContent()).toContain('Grow herbs');
        expect.soft(screen.getTextContent()).toContain('author=Maya Rowan');
        expect.soft(screen.getTextContent()).toContain('1.0.0');
        expect.soft(screen.getTextContent()).toContain('sharing=botTemplates.shared');
        expect(screen.findByTestId('bot-template-make-own')).not.toBeNull();
        expect(screen.findByTestId('bot-template-create')).toBeNull();
        expect(home.boundary.list()).toHaveLength(1);
        expect(home.requests.filter(request => request.method !== 'GET' && !request.path.endsWith('/read'))).toEqual([]);
        expect(home.requests.some(request => request.path.includes('/machines') || request.path.includes('/inventory')
            || request.path.includes('/profile') || request.path.includes('/users/'))).toBe(false);
        await screen.pressByTestIdAsync('bot-template-make-own');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('botTemplateRecipient.create'));
        expect(screen.getTextContent()).not.toContain('Grow herbs');
        await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
        expect(screen.getTextContent()).toContain('Grow herbs');
        expect.soft(screen.getTextContent()).toContain('author=Maya Rowan');
        expect.soft(screen.getTextContent()).toContain('1.0.0');
        expect.soft(screen.getTextContent()).toContain('sharing=botTemplates.shared');
        expect(screen.findByTestId('new-session-composer-input')).toBeNull();
        expect(screen.findByTestId('new-session-composer-send')).toBeNull();
        expect(screen.findByTestId('bot-template-connect-issues')).not.toBeNull();
        expect(screen.getTextContent()).toContain('botTemplateRecipient.setupIncomplete');
        expect(home.boundary.list()).toHaveLength(1);
        await screen.unmount();
    });

    // REAL-USER-PASS F13: on a phone the template page had no way back.
    it('draws a phone Back on the template page', async () => {
        vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        home = await createPlainArtifactHomeFixture('https://template-recipient-phone.test', { currentAccount: true,
            handleRequest: async path => path === '/v2/account/session-drafts/read' ? Response.json({ status: 'absent' }) : null });
        storage.setState({ isSessionDraftsReady: true });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.0.0', releasedAtMs: 1, changelog: '',
            content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Grow herbs' },
                skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
        const artifact = { v: 1 as const, state: 'released' as const, release };
        home.boundary.replaceStoredRow({ id: 'phone-template', ownerAccountId: 'artifact-account', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(projectBotTemplateArtifactHeaderV1(artifact)), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact) }), bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BotTemplateRecipientScreen source={{ kind: 'artifact', serverId: home.home.id,
            artifactId: 'phone-template' }} serverId={home.home.id} /></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('bot-template-make-own')).not.toBeNull());
        expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'bot-template:back').length).toBeGreaterThan(0);
        await screen.unmount();
    });
});
import '@/sync/syncEngine';
import './BotTemplateCopyForm';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
await prepareSessionDraftPersistenceStorage();
