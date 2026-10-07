import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ConnectedServiceSetupPanel, type ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';
import { ConnectedServicesConnectMore } from './ConnectedServicesConnectMore';
import { buildConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import { ConnectedServicesIndexView } from '../index/ConnectedServicesIndexView';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';

const phoneNavigation = vi.hoisted(() => ({ push: vi.fn(), width: 390 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: phoneNavigation.width, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// This setup journey does not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account setup'); },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: phoneNavigation.push } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The media-query boundary selects a real animated collapse; timing stays pending until the driver settles.
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
    readReducedMotionPreference: () => false,
}));

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
function staleServiceModel() {
    return buildConnectedServicesIndexModel({
        transport: 'advertised-v4',
        entries: [{ serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex', connectCommand: 'happier connect openai-codex',
            supportsOauth: false, executable: false, projectionStatus: 'stale',
            availability: { state: 'available', reason: 'resolved' }, projectedTitle: 'ChatGPT' }],
        qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
        resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''), resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: STALE_DIAGNOSTIC, supportDetails: null }), loadingLabel: 'Loading',
    });
}

describe('ConnectedServiceSetupPanel tools disclosure', () => {
    it('renders the service diagnostic in grid even when a known service has no accounts', async () => {
        const screen = await renderScreen(<ConnectedServicesIndexView
            model={staleServiceModel()} labelsByKey={{}}
            present={(input) => presentConnectedAccountIdentity({
                hidden: false, label: input.label ?? null, labelKind: input.labelKind,
                email: input.email ?? null, accountId: input.accountId ?? null,
            })}
            now={0} presentation="grid" onPresentationChange={() => {}} compact={false}
            summary={{ needsYouCount: 0, asOf: null }} connectMore={null}
            fixProminence="primary" settled={null}
            renderAccount={() => { throw new Error('No account exists in this diagnostic sheet'); }}
            renderPool={() => { throw new Error('No pool exists in this diagnostic sheet'); }}
            renderStar={() => null} onAddAccount={() => {}} onSignInAgain={() => {}}
            onOpenAccount={() => {}} onOpenPool={() => {}}
        />);
        expect(screen.getTextContent()).toContain(STALE_DIAGNOSTIC);
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
    it('pushes a qualified phone connect journey instead of expanding it inside the index', async () => {
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries: [], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: () => '', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [] });
        const handled = vi.fn();
        const screen = await renderScreen(<ConnectedServicesConnectMore model={model} layout="section"
            request={{ kind: 'reconnect', serviceKey: tool.serviceKey, accountId: 'personal' }} onRequestHandled={handled} onConnected={() => {}} />);
        expect(phoneNavigation.push).toHaveBeenCalledWith({ pathname: '/(app)/settings/connected-services/connect', params: { service: tool.serviceKey, accountId: 'personal' } });
        expect(screen.findByTestId('connected-services-connect-more:setup')).toBeNull();
        expect(handled).toHaveBeenCalled();
    });
    it('keeps the tools mounted while their collapse runs, with one accessible toggle', async () => {
        const screen = await renderScreen(<ConnectedServiceSetupPanel
            target={{ kind: 'catalog' }}
            catalog={[tool]}
            onTargetChange={() => {}}
            onClose={() => {}}
            renderServiceFlow={() => null}
        />);
        expect(screen.findByTestId('connected-service-setup:tools-catalog')).toBeNull();
        await screen.pressByTestIdAsync('connected-service-setup:tools');
        expect(screen.findByTestId('connected-service-setup:tools-catalog')).toBeTruthy();
        await screen.pressByTestIdAsync('connected-service-setup:tools');
        expect(screen.findHostByTestId('connected-service-setup:tools')?.props.accessibilityState?.expanded).toBe(false);
        expect(screen.findByTestId('connected-service-setup:tools-catalog')).toBeTruthy();
    });
});
