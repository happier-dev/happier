import * as React from 'react';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionAccessFixture, createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { WorkSectionPlacementProvider, WorkSectionSetupDisclosureProvider } from '@/components/sessions/work/WorkSection';
import { SessionTemplateSection } from './SessionTemplateSection';
import { createPlainArtifactHomeFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { act } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { BotTemplateRecipientInfo } from './BotTemplateRecipientInfo';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { BotTemplateReleaseV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { router } from 'expo-router';
import { buildBotTemplateRecipientRoute } from './botTemplateRecipientDestination';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('Template Info slot', () => {
    it.each([
        { version: '1.0.0', policy: 'allowed', offered: false, reads: 1 },
        { version: '1.1.0', policy: 'allowed', offered: false, reads: 1 },
        { version: '1.2.0', policy: 'allowed', offered: true, reads: 1 },
        { version: '1.2.0', policy: 'pinned', offered: false, reads: 0 },
    ] as const)('uses the addressed BT2 release for $version with $policy policy and exact skipped-version suppression', async ({ version, policy, offered, reads }) => {
        const serverUrl = `https://template-plugin-${version}-${policy}.test`;
        const sourceUrl = `${serverUrl}/catalog.json`;
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries: [{ pluginId: 'garden.bot', title: 'Garden',
            version: '9.1.0', botTemplates: [{ id: 'gardener', path: './templates/garden.json' }] }] });
        catalog.entries[0]!.updatePolicy = policy;
        const identity = `srv_plugin_${version.replaceAll('.', '_')}_${policy}`;
        const machine = createMachineFixture({ id: 'garden-carrier', activeAt: Date.now() });
        const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'artifact-account', machine });
        const release = BotTemplateReleaseV1Schema.parse({ v: 1, version, releasedAtMs: 1, changelog: '', content: {
            v: 1, identity: { name: 'Garden', description: '' }, instructions: { markdown: 'Care for herbs' },
            skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] },
        } });
        const previewSources: unknown[] = [];
        await adoptHomeProfile({ descriptor: { serverUrl, homeServerIdentityId: identity, displayName: 'Garden' },
            source: 'manual', suggestedName: 'Garden' });
        const catalogBoundary = createPromptLibraryCatalogBoundary({ records: [{
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Garden catalog',
                format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
        }] });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: identity } } });
        const home = await createPlainArtifactHomeFixture(serverUrl, { currentAccount: true, serverFeatures: features,
            handleRequest: async (path, init) => {
            const catalogResponse = await catalogBoundary.handle(path, init);
            if (catalogResponse) return catalogResponse;
            if (path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/catalog.json') return Response.json(catalog);
            if (path === '/v1/machines') return Response.json([machineRow]);
            if (path === '/v1/machines/garden-carrier') return Response.json({ machine: machineRow });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === machine.id ? machineRow : null);
            if (path !== '/v1/actions/template.preview') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            if (!envelope.input || typeof envelope.input !== 'object' || !('source' in envelope.input)) throw new Error('Expected exact template source');
            previewSources.push(envelope.input.source);
            return Response.json({ v: 1, actionId: 'template.preview', requestId: envelope.requestId,
                execution: { ok: true, result: { source: envelope.input.source, release } } });
        } });
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            const scope = { serverId: account.serverId, accountId: account.accountId };
            await storage.getState().activateSettingsScope(scope);
            storage.getState().applySettingsForScope(scope, storage.getState().settings, 1);
            // This admitted focused fixture must publish both Account projections on the adopted Home.
            storage.setState({ profileScope: scope });
            storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
            expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: identity, machineId: machine.id },
                { accountScope: scope })).not.toBeNull();
            const source = { kind: 'plugin' as const, registryItem: { sourceId, itemId: 'garden.bot', version: '9.0.0' }, contributionId: 'gardener' };
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
            const tree = (installedVersion: string) => {
                const shell: AppShellPluginUiProjectionValue = { pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION,
                    installedPackagesById: { 'garden.bot': { id: 'garden.bot', displayName: 'Garden', version: installedVersion,
                        enabled: true, source: { kind: 'registryPackage', locator: 'descriptive-installation' } } } },
                    pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: machine.id,
                    serverId: account.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
                    reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
                const original = createSessionFixture();
                const session = createSessionFixture({ ...original, id: 'recipient', metadata: { ...original.metadata!, bot: { kind: 'bot' }, work: { templateInstance: { v: 1, source,
                    acceptedVersion: '1.0.0', skippedVersion: '1.1.0', acceptedBase: { serverId: home.home.id, artifactId: 'base' },
                    skillIds: {}, mcpServerIds: {}, follow: true } } } });
                return <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={shell}>
                    <SessionTemplateSection session={session} serverId={account.serverId} />
                </AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
            };
            const screen = await renderScreen(tree('9.1.0'));
            if (!offered) await screen.pressByTestIdAsync('bot-template-recipient-row');
            try {
                if (reads) await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Garden'));
                await waitForHomeGovernance(() => offered
                    ? expect(screen.getTextContent()).toContain(version)
                    : expect(screen.findByTestId('bot-template-review-updates')).toBeNull());
            } catch (error) {
                console.error('Plugin follow boundary', { requests: home.requests.map(request => request.path), previewSources,
                    settingsScope: storage.getState().settingsScope, lifetime: captureActiveServerAccountScopeLifetime()?.scope });
                throw error;
            }
            expect(previewSources).toHaveLength(reads);
            if (reads) expect(previewSources[0]).toEqual({ ...source, registryItem: { ...source.registryItem, version: '9.1.0' } });
            if (offered) {
                catalog.entries[0]!.distribution.version = '9.2.0';
                await screen.update(tree('9.2.0'));
                await waitForHomeGovernance(() => expect(previewSources).toHaveLength(2));
                expect(previewSources[1]).toEqual({ ...source, registryItem: { ...source.registryItem, version: '9.2.0' } });
            }
            expect(home.requests.some(request => request.path.startsWith('/v1/artifacts/'))).toBe(false);
            await screen.unmount();
        } finally { account.dispose(); await home.dispose(); }
    });
    it('keeps an unchanged addressed plugin package cold without comparing its version to the template version', async () => {
        const serverUrl = 'https://template-follow-plugin.test';
        const sourceUrl = `${serverUrl}/catalog.json`;
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries: [{ pluginId: 'garden.bot', title: 'Garden',
            version: '9.0.0', botTemplates: [{ id: 'gardener', path: './templates/garden.json' }] }] });
        const home = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Garden catalog',
                format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
        }, 'updated', { handleRequest: async path => path === '/catalog.json' ? Response.json(catalog) : null });
        try {
            const source = { kind: 'plugin' as const, registryItem: { sourceId, itemId: 'garden.bot', version: '9.0.0' }, contributionId: 'gardener' };
            const screen = await renderScreen(<BotTemplateRecipientInfo instance={{ v: 1, source, acceptedVersion: '1.0.0',
                acceptedBase: { serverId: home.home.id, artifactId: 'base' }, skillIds: {}, mcpServerIds: {}, follow: true }}
                serverId={home.home.id} sessionRef={{ serverId: home.home.id, sessionId: 'recipient' }} />);
            await vi.waitFor(() => expect(screen.findByTestId('bot-template-review-updates')).toBeNull());
            expect(home.requests.some(request => request.path === '/catalog.json')).toBe(true);
            expect(home.requests.some(request => request.path.startsWith('/v1/actions/template.preview'))).toBe(false);
            expect(home.requests.some(request => request.path.startsWith('/v1/artifacts/'))).toBe(false);
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('opens only the addressed release header when the source is absent from pushed rows', async () => {
        const home = await createPlainArtifactHomeFixture('https://template-follow-cold.test', { currentAccount: true });
        try {
            const source = { kind: 'artifact' as const, serverId: home.home.id, artifactId: 'cold-source' };
            home.boundary.replaceStoredRow(createPlainArtifactHttpFixture({ id: source.artifactId, isDecrypted: true,
                title: 'Garden', header: { v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: 'Garden',
                    description: '', version: '1.0.0', changelog: '' }, headerVersion: 1, bodyVersion: 1,
                body: 'Content must stay unread', seq: 1, createdAt: 1, updatedAt: 1 }, 'artifact-account'));
            const screen = await renderScreen(<BotTemplateRecipientInfo instance={{ v: 1, source, acceptedVersion: '1.0.0',
                acceptedBase: { serverId: home.home.id, artifactId: 'base' }, skillIds: {}, mcpServerIds: {}, follow: true }}
                serverId={home.home.id} sessionRef={{ serverId: home.home.id, sessionId: 'recipient' }} />);
            await vi.waitFor(() => expect(screen.findByTestId('bot-template-review-updates')).toBeNull());
            const reads = home.requests.filter(request => request.path.startsWith('/v1/artifacts/'));
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.every(request => request.projection === 'headers')).toBe(true);
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('consumes pushed release headers and suppresses only the accepted or specifically skipped offer', async () => {
        const home = await createPlainArtifactHomeFixture('https://template-follow-header.test', { currentAccount: true });
        try {
            const source = { kind: 'artifact' as const, serverId: home.home.id, artifactId: 'follow-source' };
            const instance = { v: 1 as const, source, acceptedVersion: '1.0.0', skippedVersion: '1.1.0',
                acceptedBase: { serverId: home.home.id, artifactId: 'base' }, skillIds: {}, mcpServerIds: {}, follow: true };
            const header = (version: string) => ({ id: source.artifactId, sourceServerId: home.home.id, isDecrypted: true as const,
                title: 'Garden', header: { v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: 'Garden', description: '', version, changelog: '' },
                headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            await act(async () => { storage.getState().updateArtifact(header('1.0.0')); });
            const original = createSessionFixture();
            const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
                work: { templateInstance: instance } } });
            const screen = await renderScreen(<SessionTemplateSection session={session} serverId={home.home.id} />);
            expect(screen.findByTestId('bot-template-review-updates')).toBeNull();
            await act(async () => { storage.getState().updateArtifact(header('1.1.0')); });
            expect(screen.findByTestId('bot-template-review-updates')).toBeNull();
            await act(async () => { storage.getState().updateArtifact(header('1.2.0')); });
            expect(screen.findByTestId('bot-template-review-updates')).not.toBeNull();
            expect(screen.getTextContent()).toContain('1.2.0');
            expect(screen.getTextContent()).toContain('Garden');
            expect(screen.findByTestId('bot-template-accepted-preview')).toBeNull();
            await screen.pressByTestIdAsync('bot-template-review-updates');
            expect(router.push).toHaveBeenCalledWith(buildBotTemplateRecipientRoute(source, home.home.id,
                { serverId: home.home.id, sessionId: session.id }));
            expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('stops following from Info without loading the unavailable source or a comparison', async () => {
        const original = createSessionFixture();
        const instance = { v: 1 as const, source: { kind: 'artifact' as const, serverId: 'unavailable-home', artifactId: 'missing-source' },
            acceptedVersion: '1.2.0', acceptedBase: { serverId: 'unavailable-home', artifactId: 'accepted' },
            skillIds: {}, mcpServerIds: {}, follow: true };
        const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
            work: { templateInstance: instance } } });
        const metadata = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
        metadata.replaceSession(session.id, SessionCurrentProjectionRecordV1Schema.parse(createPlainSessionCurrentProjectionRecordFixture({
            id: session.id, metadata: session.metadata!, metadataVersion: session.metadataVersion,
        })));
        const serverUrl = 'https://template-info-stop.test';
        const boundaryErrors: string[] = [];
        const transport = createSessionReadBatchFetchBoundary(async (input, init) => {
            try { return metadata.handle(input, init); }
            catch (error) { boundaryErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
        });
        const home = await createPlainArtifactHomeFixture(serverUrl, { currentAccount: true,
            handleRequest: (path, init) => transport(new URL(path, serverUrl).href, init) });
        try {
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <WorkSectionPlacementProvider value="setup">
                    <WorkSectionSetupDisclosureProvider value={{ isExpanded: () => true, setExpanded: () => {} }}>
                        <SessionTemplateSection session={session} serverId={home.home.id} />
                    </WorkSectionSetupDisclosureProvider>
                </WorkSectionPlacementProvider>
            </InjectedAuthProvider>);
            await screen.pressByTestIdAsync('bot-template-recipient-row');
            expect(screen.findByTestId('bot-template-info-stop-following')).not.toBeNull();
            await vi.waitFor(() => expect(screen.findByTestId('bot-template-info-stop-following')?.props['aria-disabled']).not.toBe(true));
            await screen.pressByTestIdAsync('bot-template-info-stop-following');
            await vi.waitFor(() => expect(screen.getTextContent(), JSON.stringify({ boundaryErrors, requests: home.requests.map(r => r.path), codes: screen.findAll(node =>
                typeof node.props.diagnosticCode === 'string').map(node => node.props.diagnosticCode) }))
                .toContain('botTemplateRecipient.independentCopy'));
            expect(screen.findByTestId('bot-template-review-updates')).toBeNull();
            expect(metadata.writes).toContain(session.id);
            expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('shows an ordinary Plain independent copy without claiming an encryption restriction', async () => {
        const home = await createPlainArtifactHomeFixture('https://template-independent-info.test', { currentAccount: true });
        try {
            const original = createSessionFixture();
            const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
                work: { templateInstance: { v: 1, source: { kind: 'artifact', serverId: home.home.id, artifactId: 'source' },
                    acceptedVersion: '1.2.0', acceptedBase: { serverId: home.home.id, artifactId: 'accepted' },
                    skillIds: {}, mcpServerIds: {}, follow: false } } } });
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <WorkSectionPlacementProvider value="setup">
                    <WorkSectionSetupDisclosureProvider value={{ isExpanded: () => true, setExpanded: () => {} }}>
                        <SessionTemplateSection session={session} serverId={home.home.id} />
                    </WorkSectionSetupDisclosureProvider>
                </WorkSectionPlacementProvider>
            </InjectedAuthProvider>);
            await screen.pressByTestIdAsync('bot-template-recipient-row');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('botTemplateRecipient.independentCopy'));
            expect(screen.getTextContent()).toContain('botTemplateRecipient.independentCopy');
            expect(screen.findByTestId('bot-template-review-updates')).toBeNull();
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    // REAL-USER-PASS F9: the row named the template's current (truncated) name instead of whose template it is.
    it("names the author's template and the copy's version in the Template row", async () => {
        const home = await createPlainArtifactHomeFixture('https://template-follow-author.test', { currentAccount: true });
        try {
            const source = { kind: 'artifact' as const, serverId: home.home.id, artifactId: 'author-source' };
            await act(async () => { storage.getState().updateArtifact({ id: source.artifactId, sourceServerId: home.home.id, isDecrypted: true as const,
                ownerDisplayName: 'Leeroy Brun', title: 'Coffee Companion R15 Moss', header: { v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1,
                    state: 'released', title: 'Coffee Companion R15 Moss', description: '', version: '1.0.0', changelog: '' },
                headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }); });
            const original = createSessionFixture();
            const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
                work: { templateInstance: { v: 1, source, acceptedVersion: '1.0.0', acceptedBase: { serverId: home.home.id, artifactId: 'base' },
                    skillIds: {}, mcpServerIds: {}, follow: true } } } });
            const screen = await renderScreen(<SessionTemplateSection session={session} serverId={home.home.id} />);
            expect(screen.getTextContent()).toContain('botTemplates.authorsTemplate(author=Leeroy Brun)');
            expect(screen.getTextContent()).toContain('v1.0.0');
            expect(screen.getTextContent()).not.toContain('Coffee Companion R15 Moss');
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('offers update review for a following copy in Info', async () => {
        const original = createSessionFixture();
        const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
            work: { templateInstance: { v: 1, source: { kind: 'artifact', serverId: 'source-home', artifactId: 'source' },
                acceptedVersion: '1.2.0', acceptedBase: { serverId: 'home', artifactId: 'accepted' }, skillIds: {}, mcpServerIds: {}, follow: true } } } });
        const screen = await renderScreen(<WorkSectionPlacementProvider value="setup">
            <WorkSectionSetupDisclosureProvider value={{ isExpanded: () => true, setExpanded: () => {} }}>
                <SessionTemplateSection session={session} serverId="home" />
            </WorkSectionSetupDisclosureProvider>
        </WorkSectionPlacementProvider>);
        await screen.pressByTestIdAsync('bot-template-recipient-row');
        expect(screen.findByTestId('bot-template-review-updates')).not.toBeNull();
        await screen.unmount();
    });
    it('does not offer a drafting turn to a view-only participant or a regular Session', async () => {
        const session = createSessionFixture({ access: createSessionAccessFixture('view'),
            metadata: { path: '/garden', host: 'home', bot: { kind: 'bot' } } });
        const screen = await renderScreen(<SessionTemplateSection session={session} serverId="home" />);
        expect(screen.findByTestId('session-template-section')).toBeNull();
        await screen.update(<SessionTemplateSection session={createSessionFixture()} serverId="home" />);
        expect(screen.findByTestId('session-template-section')).toBeNull();
    });
    it('keeps the author door beside accepted provenance in one disclosure for a copied Bot', async () => {
        const original = createSessionFixture();
        const session = createSessionFixture({ ...original, metadata: { ...original.metadata!, bot: { kind: 'bot' },
            work: { templateInstance: { v: 1, source: { kind: 'artifact', serverId: 'home', artifactId: 'source' },
                acceptedVersion: '1.2.0', acceptedBase: { serverId: 'home', artifactId: 'accepted' }, skillIds: {}, mcpServerIds: {}, follow: false } } } });
        const screen = await renderScreen(<WorkSectionPlacementProvider value="setup">
            <WorkSectionSetupDisclosureProvider value={{ isExpanded: () => true, setExpanded: () => {} }}>
                <SessionTemplateSection session={session} serverId="home" />
            </WorkSectionSetupDisclosureProvider>
        </WorkSectionPlacementProvider>);
        expect(screen.findByTestId('bot-template-accepted-preview')).toBeNull();
        expect(screen.findByTestId('bot-template-author-door')).toBeNull();
        await screen.pressByTestIdAsync('bot-template-recipient-row');
        expect(screen.getTextContent()).toContain('1.2.0');
        expect(screen.getTextContent()).toContain('botTemplateRecipient.independentCopy');
        expect(screen.findByTestId('bot-template-author-door')).not.toBeNull();
        expect(screen.findByTestId('bot-template-accepted-preview')).not.toBeNull();
        await screen.unmount();
    });
});
