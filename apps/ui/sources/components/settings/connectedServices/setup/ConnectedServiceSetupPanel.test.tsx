import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ConnectedServiceSetupPanel, presentConnectedServiceSetupHeading, type ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';
import { ConnectedServicesConnectMore } from './ConnectedServicesConnectMore';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { ConnectedServicesIndexView } from '../index/ConnectedServicesIndexView';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { selectNewPoolServices } from '../collection/NewPoolMenu';
import { Item } from '@/components/ui/lists/Item';
import { CollectionDraftRow } from '@/components/ui/lists/collection/CollectionList';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';

const phoneNavigation = vi.hoisted(() => ({ push: vi.fn(), width: 390 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    // Responsive presentation reads the OS Dimensions authority directly.
    Dimensions: { get: () => ({ width: phoneNavigation.width, height: 844, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: phoneNavigation.width, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// This setup journey does not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account setup'); },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: phoneNavigation.push } }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The media-query boundary selects a real animated collapse; timing stays pending until the driver settles.

afterEach(async () => { phoneNavigation.width = 390; await standardCleanup(); });

function DraftFlow() {
    const [draft, setDraft] = React.useState('');
    return React.createElement('DraftFlow', { draft, setDraft });
}

const tool: ConnectedServiceSetupCatalogEntry = {
    serviceKey: 'happier.scm.forge.github/github-account',
    service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
    entry: null,
    legacyServiceId: 'github',
    label: 'GitHub',
    usedBy: [],
    usedByAgentIds: [],
    connectedCount: 0,
    section: 'tools',
    canAdd: true,
};

const STALE_DIAGNOSTIC = 'The service catalog could not be refreshed';
function staleServiceModel(withAccount = false, policyBlocked = false) {
    return buildConnectedServicesIndexModel({
        transport: 'advertised-v4',
        entries: [{ serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex', connectCommand: 'happier connect openai-codex',
            supportsOauth: false, executable: false, projectionStatus: 'stale',
            availability: policyBlocked ? { state: 'blocked', reason: 'policy_refused' }
                : { state: 'available', reason: 'resolved' }, projectedTitle: 'ChatGPT' }],
        qualifiedAccounts: withAccount ? [QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
            status: 'needs_reauth', kind: 'oauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null, scopes: [],
        })] : [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
        resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: STALE_DIAGNOSTIC, supportDetails: null }), loadingLabel: 'Loading',
        agentUses: [{ agentId: 'codex', title: 'Codex',
            services: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }], defaults: [] }],
    });
}

describe('presentConnectedServiceSetupHeading', () => {
    it('says what a service without agents is for in its declaration’s words', () => {
        const hetzner: ConnectedServiceSetupCatalogEntry = { ...tool, serviceKey: 'happier.machine.hetzner/hetzner-account',
            service: { pluginId: 'happier.machine.hetzner', localId: 'hetzner-account' }, legacyServiceId: null, label: 'Hetzner cloud account',
            entry: { serviceId: 'hetzner-account', connectCommand: '', supportsOauth: false,
                projectedDescription: 'Run coding sessions on Hetzner Cloud servers.' } as ConnectedServiceSetupCatalogEntry['entry'] };
        expect(presentConnectedServiceSetupHeading({ selected: hetzner, targetKind: 'service', scope: 'all', chrome: 'sheet', machineRequired: false }).purpose)
            .toBe('Run coding sessions on Hetzner Cloud servers.');
    });
});

describe('ConnectedServiceSetupPanel tools disclosure', () => {
    it.each(['page', 'frame', 'card'] as const)('keeps the account placeholder for %s setup until an account name is entered', async chrome => {
        let publish: (title: string) => void = () => { throw new Error('Draft title scope has not mounted'); };
        function DraftRow() {
            const titles = useCollectionDraftTitle();
            publish = titles.publish;
            return <CollectionDraftRow testID="setup-draft-title" titles={titles} placeholder="New GitHub account" />;
        }
        const element = (shown: boolean) => <CollectionDraftTitleScope><DraftRow />{shown ? <ConnectedServiceSetupPanel
            target={{ kind: 'service', serviceKey: tool.serviceKey }} catalog={[tool]} chrome={chrome}
            onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => <DraftFlow />}
        /> : null}</CollectionDraftTitleScope>;
        const screen = await renderScreen(element(true));
        const rowText = () => screen.findHostByTestId('setup-draft-title')!.findAll(node =>
            node.children.includes('New GitHub account'));
        expect(rowText()).not.toHaveLength(0);
        await act(async () => { publish('Work account'); });
        await screen.update(element(false));
        expect(screen.findHostByTestId('setup-draft-title')!.findAll(node =>
            node.children.includes('Work account'))).not.toHaveLength(0);
    });

    it('names an added account\'s page like its draft row and keeps the card and frame titled Connect', async () => {
        const render = (chrome: 'page' | 'frame') => renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'service', serviceKey: tool.serviceKey }} catalog={[tool]} chrome={chrome}
            onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => <DraftFlow />}
        />);
        const page = await render('page');
        expect(page.getTextContent()).toContain(`connectedServicesCollection.newAccountDraft(service=${tool.label})`);
        expect(page.getTextContent()).toContain('connectedServicesSettings.detailSignInTitle');
        const frame = await render('frame');
        expect(frame.getTextContent()).toContain(`connectedServicesSettings.setupServiceTitle(service=${tool.label})`);
    });

    it('labels the locked setup page cancel action and lets the person close it', async () => {
        const close = vi.fn();
        const screen = await renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }} catalog={[]} onTargetChange={() => {}} onClose={close}
            chrome="page" targetLocked renderServiceFlow={() => null}
        />);
        expect(screen.findHostByTestId('connected-service-setup:close')?.props.accessibilityLabel).toBe('common.cancel');
        await screen.pressByTestIdAsync('connected-service-setup:close');
        expect(close).toHaveBeenCalledOnce();
    });

    it('names a machine only when the chosen method needs one, not for every catalog target (D21)', async () => {
        const { createMachineAdministrationTargetSelectionFixture } = await import('@/dev/testkit/mocks/machineAdministrationTargetSelection');
        const selection = createMachineAdministrationTargetSelectionFixture();
        const chips = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.root.findAll(node => typeof node.props.testIDPrefix === 'string' && node.props.testIDPrefix === 'connected-service-setup-target');
        const screen = await renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }} catalog={[tool]} chrome="page" targetSelection={selection}
            onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => null}
        />);
        expect(chips(screen)).toHaveLength(0);
        // The purpose line follows the same decision: it never says sign-in runs on a machine you pick.
        expect(screen.getTextContent()).toContain('connectedServicesSettings.setupCatalogPurposeNoMachine');
        expect(screen.getTextContent()).not.toMatch(/setupCatalogPurpose(?!NoMachine)/);
        expect(presentConnectedServiceSetupHeading({ selected: null, targetKind: 'catalog', scope: 'all', machineRequired: true }).purpose)
            .toBe('connectedServicesSettings.setupCatalogPurpose');
    });

    it('leaves the Providers pointer to the open catalog, not to a page locked to one requested purpose', async () => {
        const render = (targetLocked: boolean) => renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }} catalog={[]} onTargetChange={() => {}} onClose={() => {}}
            chrome="page" targetLocked={targetLocked} renderServiceFlow={() => null}
        />);
        expect((await render(false)).getTextContent()).toContain('connectedServicesSettings.setupProvidersPointer');
        expect((await render(true)).getTextContent()).not.toContain('connectedServicesSettings.setupProvidersPointer');
    });

    it.each(['list', 'grid'] as const)('lists a phone\'s accounts in the same sections for the %s preference, the signed-out one first, and settles a new one in place', async (presentation) => {
        const element = <ConnectedServicesIndexView
            model={staleServiceModel(true)} labelsByKey={{}} present={(input) => presentConnectedAccountIdentity({
                ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
            })}
            now={0} presentation={presentation} onPresentationChange={() => {}} compact
            summary={{ needsYouCount: 1, asOf: null }} connectMore={null} fixProminence="primary" settled={null}
            renderAccount={({ render }) => render({ usage: { kind: 'none' }, planLabel: null, subscription: null,
                recoveryCredits: null, fetchedAt: null, staleSince: null, refreshing: false, refresh: null })}
            renderPool={() => { throw new Error('No pool exists'); }} renderStar={() => null}
            onAddAccount={() => {}} onSignInAgain={() => {}} onOpenAccount={() => {}} onOpenPool={() => {}}
        />;
        const screen = await renderScreen(element);
        // One presentation on a phone too (crHome A): no per-service disclosure; Needs you leads with the fix.
        expect(screen.findHostByTestId('connected-services-index:needs-you')).not.toBeNull();
        expect(screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work')).not.toBeNull();
        expect(screen.getTextContent()).toContain('connectedServicesSettings.signedOut');
        await act(async () => screen.update(React.cloneElement(element, { settled: {
            serviceKey: 'happier.agent.codex/openai-codex', accountId: 'work',
            node: <View testID="connected-account-next-step" />,
        } })));
        expect(screen.findHostByTestId('connected-account-next-step')).not.toBeNull();
    });

    it.each(['list', 'grid'] as const)('retains credential warnings in %s without admitting Add, reconnect or New pool when policy refuses authoring', async (presentation) => {
        const model = staleServiceModel(true, true);
        const reconnect = vi.fn();
        const screen = await renderScreen(<ConnectedServicesIndexView
            model={model} labelsByKey={{}} present={(input) => presentConnectedAccountIdentity({
                ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
            })}
            now={0} presentation={presentation} onPresentationChange={() => {}} compact={false}
            summary={{ needsYouCount: 1, asOf: null }} connectMore={null} fixProminence="primary" settled={null}
            renderAccount={({ render }) => render({ usage: { kind: 'none' }, planLabel: null, subscription: null,
                recoveryCredits: null, fetchedAt: null, staleSince: null, refreshing: false, refresh: null })}
            renderPool={() => { throw new Error('No pool exists in this diagnostic sheet'); }} renderStar={() => null}
            onAddAccount={() => {}} onSignInAgain={reconnect} onOpenAccount={() => {}} onOpenPool={() => {}}
        />);
        expect(screen.getTextContent()).toContain('connectedServicesSettings.signedOut');
        expect(screen.findHostByTestId('connected-services-service:happier.agent.codex/openai-codex:add-account')).toBeNull();
        const action = screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work:sign-in-again');
        if (action) expect(action.props.disabled).toBe(true);
        await act(async () => { action?.props.onPress?.(); });
        expect(selectNewPoolServices(model)).toEqual([]);
        expect(reconnect).not.toHaveBeenCalled();
    });

    it.each(['list', 'grid'] as const)('uses the model verdict in %s diagnostics even when a known service has no accounts', async (presentation) => {
        const model = staleServiceModel();
        const screen = await renderScreen(<ConnectedServicesIndexView
            model={{ ...model, sheets: model.sheets.map(sheet => ({ ...sheet, supportDetails: STALE_DIAGNOSTIC })) }} labelsByKey={{}}
            present={(input) => presentConnectedAccountIdentity({
                hidden: false, label: input.label ?? null, labelKind: input.labelKind,
                email: input.email ?? null, accountId: input.accountId ?? null,
            })}
            now={0} presentation={presentation} onPresentationChange={() => {}} compact={false}
            summary={{ needsYouCount: 0, asOf: null }} connectMore={null}
            fixProminence="primary" settled={null}
            renderAccount={() => { throw new Error('No account exists in this diagnostic sheet'); }}
            renderPool={() => { throw new Error('No pool exists in this diagnostic sheet'); }}
            renderStar={() => null} onAddAccount={() => {}} onSignInAgain={() => {}}
            onOpenAccount={() => {}} onOpenPool={() => {}}
        />);
        expect(screen.getTextContent()).toContain(STALE_DIAGNOSTIC);
        const details = screen.tree.findAllByType(Item).find(row =>
            row.props.testID === 'connected-services-index:happier.agent.codex/openai-codex:support-details');
        // The service's own row states the verdict once and opens its details.
        expect(details?.props.subtitle ?? STALE_DIAGNOSTIC).toBe(presentation === 'list' ? STALE_DIAGNOSTIC : 'settingsPlugins.diagnosticsTitle');
    });

    it('opens the known-service catalog when every service is non-executable', async () => {
        phoneNavigation.width = 1440;
        const screen = await renderScreen(<ConnectedServicesConnectMore
            model={staleServiceModel()} layout="section" request={{ kind: 'catalog' }}
            onRequestHandled={() => {}} onConnected={() => {}} renderServiceFlow={() => <DraftFlow />}
        />);
        expect(screen.findHostByTestId('connected-services-connect-more:setup')).not.toBeNull();
        expect(screen.findHostByTestId('connected-service-setup:block:happier.agent.codex/openai-codex')).not.toBeNull();
        expect(screen.getTextContent()).toContain(STALE_DIAGNOSTIC);
    });

    it('retains the open inline service flow and its draft across phone and desktop presentation', async () => {
        phoneNavigation.width = 1440;
        const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4',
            entries: [{ serviceId: 'anthropic', service, connectCommand: 'happier connect anthropic', supportsOauth: false,
                executable: true, projectedTitle: 'Anthropic API key' }],
            qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: entry => String(entry?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
            agentUses: [{ title: 'Claude', services: [service], defaults: [] }] });
        const element = <ConnectedServicesConnectMore model={model} layout="section"
            request={{ kind: 'service', serviceKey: 'happier.agent.claude/anthropic' }}
            onRequestHandled={() => {}} onConnected={() => {}} renderServiceFlow={() => <DraftFlow />} />;
        const screen = await renderScreen(element);
        await act(async () => { screen.root.findByType('DraftFlow').props.setDraft('unsaved name'); });
        for (const width of [390, 1440]) {
            phoneNavigation.width = width;
            await act(async () => { screen.update(React.cloneElement(element)); });
            expect(screen.root.findByType('DraftFlow').props.draft).toBe('unsaved name');
        }
    });
    it('keeps a connected agent service in Connect more with its count, offering another account', async () => {
        phoneNavigation.width = 1440;
        const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4',
            entries: [{ serviceId: 'claude-subscription', service, connectCommand: 'happier connect claude', supportsOauth: true,
                executable: true, projectedTitle: 'Claude subscription' }],
            qualifiedAccounts: [QualifiedConnectedAccountProfileV4Schema.parse({
                ref: { service, accountId: 'work' }, status: 'connected', kind: 'oauth', authenticationModeId: 'oauth',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true,
                configurationRevision: null, scopes: [],
            })], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: entry => String(entry?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
            agentUses: [{ title: 'Claude', services: [service], defaults: [] }] });
        const screen = await renderScreen(<ConnectedServicesConnectMore model={model} layout="section"
            request={null} onRequestHandled={() => {}} onConnected={() => {}} renderServiceFlow={() => <DraftFlow />} />);
        const tile = screen.root.findAll((node) => node.props?.testID === 'connected-services-connect-more:happier.agent.claude/claude-subscription'
            && node.props?.action)[0];
        expect(tile).toBeTruthy();
        expect(tile!.props.action.label).toBe('connectedServicesSettings.addAccount');
        expect(tile!.props.subtitle).toContain('connectedServicesSettings.setupConnectedCount');
    });
    it.each(['section', 'firstRun'] as const)('opens phone %s Connect from its actual control', async (layout) => {
        phoneNavigation.width = 390;
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4',
            entries: [{ serviceId: 'openai-codex', service, connectCommand: 'happier connect openai-codex', supportsOauth: true,
                executable: true, projectedTitle: 'ChatGPT' }],
            qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: entry => String(entry?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
            agentUses: [{ title: 'Codex', services: [service], defaults: [] }] });
        const screen = await renderScreen(<ConnectedServicesConnectMore model={model} layout={layout}
            request={null} onRequestHandled={() => {}} onConnected={() => {}} />);
        const testID = layout === 'section' ? 'connected-services-connect-more:happier.agent.codex/openai-codex.action'
            : 'connected-service-setup:connect:happier.agent.codex/openai-codex';
        const trigger = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 32 }) };
        await act(async () => { screen.findHostByTestId(testID)!.props.onPress({ currentTarget: trigger }); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ request: {
            scope: null, service, anchor: { kind: 'view', ref: { current: trigger } },
        } }) }));
    });
    it('presents the qualified phone reconnect journey in place', async () => {
        phoneNavigation.width = 390;
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        phoneNavigation.push.mockClear();
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries: [], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: () => '', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [] });
        const handled = vi.fn();
        const screen = await renderScreen(<ConnectedServicesConnectMore model={model} layout="section"
            request={{ kind: 'reconnect', serviceKey: tool.serviceKey, accountId: 'personal' }} onRequestHandled={handled} onConnected={() => {}} />);
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ request: {
            scope: null, service: tool.service, intent: 'reconnect', account: { service: tool.service, accountId: 'personal' },
        } }) }));
        expect(phoneNavigation.push).not.toHaveBeenCalled();
        expect(screen.findByTestId('connected-services-connect-more:setup')).toBeNull();
        expect(handled).toHaveBeenCalled();
    });
    it('keeps the tools mounted while their collapse runs, with one accessible toggle', async () => {
        const agentService: ConnectedServiceSetupCatalogEntry = { ...tool, serviceKey: 'happier.agent.claude/claude-subscription',
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, legacyServiceId: 'claude-subscription',
            label: 'Claude', usedBy: ['Claude'], usedByAgentIds: ['claude'], section: 'agents' };
        const screen = await renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }}
            catalog={[agentService, tool]}
            onTargetChange={() => {}}
            onClose={() => {}}
            renderServiceFlow={() => null}
        />);
        expect(screen.findByTestId('connected-service-setup:group-catalog:code-tools')).toBeNull();
        await screen.pressByTestIdAsync('connected-service-setup:group:code-tools');
        expect(screen.findByTestId('connected-service-setup:group-catalog:code-tools')).toBeTruthy();
        await screen.pressByTestIdAsync('connected-service-setup:group:code-tools');
        expect(screen.findHostByTestId('connected-service-setup:group:code-tools')?.props.accessibilityState?.expanded).toBe(false);
        expect(screen.findByTestId('connected-service-setup:group-catalog:code-tools')).toBeTruthy();
    });
    it('offers the agent\'s own login only while an agent uses a listed service', async () => {
        const agentService: ConnectedServiceSetupCatalogEntry = { ...tool, serviceKey: 'happier.agent.claude/claude-subscription',
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, legacyServiceId: 'claude-subscription',
            label: 'Claude', usedBy: ['Claude'], usedByAgentIds: ['claude'], section: 'agents' };
        const render = (catalog: readonly ConnectedServiceSetupCatalogEntry[]) => renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }} chrome="page" catalog={catalog} onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => null} />);
        const cloudOnly = await render([tool]);
        expect(cloudOnly.findByTestId('connected-service-setup:own-login')).toBeNull();
        await cloudOnly.unmount();
        const withAgent = await render([agentService, tool]);
        expect(withAgent.findByTestId('connected-service-setup:own-login')).toBeTruthy();
        await withAgent.unmount();
    });
    it('files a cloud-machines service under Cloud machines, apart from code tools, as the Add menu does', async () => {
        const cloud: ConnectedServiceSetupCatalogEntry = { ...tool, serviceKey: 'happier.machine.vercel/vercel-account',
            service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, legacyServiceId: null, label: 'Vercel', category: 'cloud-machines' };
        const screen = await renderScreen(<ConnectedServiceSetupPanel target={{ kind: 'catalog' }} chrome="page" catalog={[cloud, tool]}
            onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => null} />);
        const { connectedServiceSetupCategoryTitle } = await import('./buildConnectedServiceSetupCatalog');
        const header = screen.findHostByTestId('connected-service-setup:group:cloud-machines')!;
        expect(header.findAll(node => node.children.includes(connectedServiceSetupCategoryTitle('cloud-machines')))).not.toHaveLength(0);
        expect(header.findAll(node => node.children.includes('Vercel'))).not.toHaveLength(0);
        // Code hosts keep their own group: the cloud service is not filed under it.
        const tools = screen.findHostByTestId('connected-service-setup:group:code-tools')!;
        expect(tools.findAll(node => String(node.children).includes('Vercel'))).toHaveLength(0);
        expect(tools.findAll(node => String(node.children).includes('GitHub'))).not.toHaveLength(0);
        await screen.unmount();
    });
    it('shows a catalog\'s only group bare, its services one press away', async () => {
        const cloud: ConnectedServiceSetupCatalogEntry = { ...tool, serviceKey: 'happier.machine.vercel/vercel-account',
            service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, legacyServiceId: null, label: 'Vercel', category: 'cloud-machines' };
        const screen = await renderScreen(<ConnectedServiceSetupPanel target={{ kind: 'catalog' }} chrome="page" catalog={[cloud]}
            onTargetChange={() => {}} onClose={() => {}} renderServiceFlow={() => null} />);
        expect(screen.findByTestId('connected-service-setup:group:cloud-machines')).toBeNull();
        expect(screen.findByTestId('connected-service-setup:group-catalog:cloud-machines')).toBeTruthy();
        await screen.unmount();
    });
});
