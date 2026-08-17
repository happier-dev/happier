import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    flushHookEffects,
    installProviderSettingsRpcBoundary,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { getActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    enabled: true,
    providerDecisionState: 'enabled' as 'enabled' | 'loading',
    credential: null as null | { required: boolean; keyUrl?: string },
    provenance: 'first_party' as 'first_party' | 'external',
    contributionKey: 'acme.plugin/ollama',
    providerName: 'Ollama',
    websiteUrl: null as string | null,
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat' as const }] as Array<{
        id: string;
        protocol: 'openai-responses' | 'openai-chat' | 'anthropic';
    }>,
    savedSecrets: [] as Array<{
        id: string;
        name: string;
        kind: 'apiKey';
        encryptedValue: { _isSecretValue: true; encryptedValue: { t: 'enc-v1'; c: string } };
        createdAt: number;
        updatedAt: number;
    }>,
}));
const run = vi.hoisted(() => vi.fn());
const providerDecisionListeners = vi.hoisted(() => new Set<() => void>());
const probeProviderDraft = vi.hoisted(() => vi.fn());
const describeProviderConnections = vi.hoisted(() => vi.fn());
const focusField = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
const modalAlert = vi.hoisted(() => vi.fn());
const modalShow = vi.hoisted(() => vi.fn((_content: unknown) => 'provider-secret-picker'));
const savedSecretListeners = vi.hoisted(() => new Set<() => void>());
const navigationDispatch = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlert, show: modalShow } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: { openURL: openUrl },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPush, replace: routerReplace },
            navigation: {
                addListener: () => () => undefined,
                dispatch: navigationDispatch,
                isFocused: () => true,
            },
        }).module;
    },
    storage: async () => ({
        useAllMachines: () => [{
            id: 'machine-a', active: true, revokedAt: null,
            metadata: { displayName: 'Mac' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1, activeAt: 1,
        }],
        useMachineListByServerId: () => ({ 'server-a': [{ id: 'machine-a', active: true, revokedAt: null }] }),
        useSetting: () => React.useSyncExternalStore(
            (listener) => {
                savedSecretListeners.add(listener);
                return () => savedSecretListeners.delete(listener);
            },
            () => state.savedSecrets,
            () => state.savedSecrets,
        ),
        useSettingMutable: () => {
            const secrets = React.useSyncExternalStore(
                (listener) => {
                    savedSecretListeners.add(listener);
                    return () => savedSecretListeners.delete(listener);
                },
                () => state.savedSecrets,
                () => state.savedSecrets,
            );
            return [secrets, vi.fn()];
        },
    }),
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => state.enabled }));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => {
        const [, rerender] = React.useReducer((value: number) => value + 1, 0);
        React.useEffect(() => {
            const listener = () => rerender();
            providerDecisionListeners.add(listener);
            return () => {
                providerDecisionListeners.delete(listener);
            };
        }, []);
        return !state.enabled
            ? { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' }
            : state.providerDecisionState === 'loading'
                ? null
                : { state: 'enabled', blockedBy: null, blockerCode: 'none' };
    },
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'server-a' }) }));
vi.mock('@/components/ui/forms/MachineSetupTextField', () => ({
    MachineSetupTextField: React.forwardRef((props: Record<string, unknown>, ref) => {
        React.useImperativeHandle(ref, () => ({
            focus: () => focusField(String(props.testID ?? props.label ?? 'unknown')),
        }));
        return React.createElement('MachineSetupTextField', props);
    }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { children?: React.ReactNode; rightElement?: React.ReactNode }) => React.createElement(
        'Item',
        props,
        props.children,
        props.rightElement,
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/components/settings/providers/ProviderMachineSelector', () => ({ ProviderMachineSelector: () => null }));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: () => null }));

function findProviderExternalLink(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    label: string,
) {
    return screen.findAll((node) => (
        node.props.accessibilityRole === 'link'
        && node.props.accessibilityLabel === label
        && typeof node.props.onPress === 'function'
    )).at(-1);
}

describe('ProviderConnectionAuthoringScreen', () => {
    afterEach(standardCleanup);
    beforeEach(() => {
        providerHarness.reset();
        state.enabled = true;
        state.providerDecisionState = 'enabled';
        state.credential = null;
        state.provenance = 'first_party';
        state.contributionKey = 'acme.plugin/ollama';
        state.providerName = 'Ollama';
        state.websiteUrl = null;
        state.endpointTemplates = [{ id: 'chat', protocol: 'openai-chat' }];
        run.mockReset();
        openUrl.mockReset();
        openUrl.mockResolvedValue(undefined);
        modalAlert.mockReset();
        modalShow.mockClear();
        state.savedSecrets = [];
        navigationDispatch.mockReset();
        routerPush.mockReset();
        routerReplace.mockReset();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;
        focusField.mockReset();
        probeProviderDraft.mockReset();
        probeProviderDraft.mockResolvedValue({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:test' });
        describeProviderConnections.mockReset();
        describeProviderConnections.mockResolvedValue({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved', connectionId: 'pc_preview',
                contributionKey: 'acme.plugin/ollama', created: true,
                candidateId: 'discovery-candidate:v1:default',
                scope: 'machine',
                machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'chat', protocol: 'openai-chat',
                    normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:default',
                revision: 1,
            },
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => {
            const payload = request.payload as { authoringPreview?: unknown };
            if (payload.authoringPreview) return await describeProviderConnections(payload);
            return createProviderConnectionsDescribeFixture({
                connections: [],
                available: [{
                    contributionKey: state.contributionKey,
                    name: state.providerName,
                    kind: 'local',
                    credential: state.credential,
                    provenance: state.provenance,
                    icon: null,
                    endpointTemplates: state.endpointTemplates,
                    ...(state.websiteUrl ? { websiteUrl: state.websiteUrl } : {}),
                }],
            });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, async (request) => (
            await probeProviderDraft(request.payload)
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (request, next) => {
            const payload = request.payload as { action?: string; connectionId?: string };
            const key = payload.action === 'createContribution' || payload.action === 'createCustom'
                ? 'save'
                : payload.connectionId;
            return await run(payload, key) ?? await next();
        });
    });

    it('renders contribution metadata supplied by the shared Provider RPC boundary', async () => {
        state.contributionKey = 'acme.plugin/boundary';
        state.providerName = 'Boundary provider';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/boundary" />,
        );

        expect(screen.findAllByType('ItemGroup').map((group) => group.props.title))
            .toContain('Boundary provider');
    });

    it('opens the projected API-key destination without mutating the Provider draft', async () => {
        state.credential = { required: true, keyUrl: 'https://keys.example.test' };
        describeProviderConnections.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved', connectionId: 'pc_preview',
                contributionKey: 'acme.plugin/ollama', created: true,
                candidateId: 'discovery-candidate:v1:default',
                scope: 'machine', machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'chat', protocol: 'openai-chat',
                    normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                }],
                credential: { slotId: 'apiKey', label: 'api_key', required: true },
                fingerprint: 'authoring-review:v1:default', revision: 1,
            },
        });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        const getKeyRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.accessibilityLabel).toBe('settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.onPress).toBeUndefined();
        await React.act(async () => {
            await findProviderExternalLink(screen, 'settingsProviders.links.getApiKey')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(openUrl).toHaveBeenCalledWith('https://keys.example.test');
        expect(run).not.toHaveBeenCalled();
    });

    it('shows the Provider website independently from credential metadata', async () => {
        state.websiteUrl = 'https://provider.example.test';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        const websiteRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.links.providerWebsite');

        expect(websiteRow?.props.accessibilityLabel).toBe('settingsProviders.links.providerWebsite');
        expect(websiteRow?.props.onPress).toBeUndefined();
        expect(titles).not.toContain('settingsProviders.links.getApiKey');
        await React.act(async () => {
            await findProviderExternalLink(screen, 'settingsProviders.links.providerWebsite')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test');
        expect(run).not.toHaveBeenCalled();
    });

    it('fails closed without any Provider RPC when the feature is unavailable', async () => {
        state.enabled = false;
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.unavailable');
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('recovers a directly opened authoring route when Provider availability finishes loading', async () => {
        state.providerDecisionState = 'loading';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const element = <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />;
        const screen = await renderScreen(element);

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.availabilityChecking');
        expect(providerHarness.state.requests).toEqual([]);

        state.providerDecisionState = 'enabled';
        await React.act(async () => {
            providerDecisionListeners.forEach((listener) => listener());
            await Promise.resolve();
        });
        await flushHookEffects();
        expect(providerHarness.state.requests.map((request) => request.method)).toContain(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        );
    });

    it('invalidates a late authoring preview when the feature becomes unavailable', async () => {
        let resolveLatePreview: ((value: unknown) => void) | undefined;
        describeProviderConnections.mockReturnValueOnce(new Promise((resolve) => {
            resolveLatePreview = resolve;
        }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        expect(describeProviderConnections).toHaveBeenCalledOnce();

        state.enabled = false;
        await screen.update(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                displayName="force-disabled-render"
            />,
        );
        await React.act(async () => {
            resolveLatePreview?.(createProviderConnectionsDescribeFixture({
                connections: [],
                authoringPreview: {
                    status: 'resolved',
                    connectionId: ProviderConnectionIdSchema.parse('pc_preview'),
                    contributionKey: 'acme.plugin/ollama',
                    created: true,
                    candidateId: 'discovery-candidate:v1:late',
                    scope: 'machine',
                    machineId: 'machine-a',
                    endpoints: [{
                        endpointTemplateId: 'chat',
                        protocol: 'openai-chat',
                        normalizedUrl: 'http://127.0.0.1:19999/v1',
                        locality: 'loopback',
                        scope: 'machine',
                    }],
                    credential: null,
                    fingerprint: 'authoring-review:v1:late',
                    revision: 1,
                },
            }));
            await Promise.resolve();
        });

        state.enabled = true;
        await screen.update(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                displayName="force-enabled-render"
            />,
        );

        expect(describeProviderConnections).toHaveBeenCalledTimes(2);
        const subtitles = screen.findAllByType('Item').map((item) => item.props.subtitle);
        expect(subtitles).toContain('http://127.0.0.1:11434/v1');
        expect(subtitles).not.toContain('http://127.0.0.1:19999/v1');
    });

    it('does not show a fake API-key control for a no-auth contribution', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionAuthoringScreen, {
            contributionKey: 'acme.plugin/ollama',
        }));
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.authoring.apiKey');
    });

    it('labels only externally sourced contributions as experimental', async () => {
        state.provenance = 'external';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const external = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        expect(external.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.compatibility.experimental');

        state.provenance = 'first_party';
        const bundled = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        expect(bundled.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.compatibility.experimental');
    });

    it('shows an API-key control for optional or required credential contributions', async () => {
        state.credential = { required: false };
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionAuthoringScreen, {
            contributionKey: 'acme.plugin/ollama',
        }));
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.authoring.apiKey');
    });

    it('does not create a contribution when its required Saved Secret is missing', async () => {
        state.credential = { required: true };
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const connect = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.connect');
        await React.act(async () => { await connect?.props.onPress?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.secretMissingTitle');
    });

    it('preserves explicit disabled intent when connecting a built-in contribution', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const enable = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving');
        expect(enable).toBeDefined();
        await React.act(async () => { enable?.props.rightElement.props.onValueChange(false); });
        const connect = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.connect');
        await React.act(async () => { await connect?.props.onPress?.(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            enable: false,
            authoringReview: {
                candidateId: 'discovery-candidate:v1:default',
                fingerprint: 'authoring-review:v1:default',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save');
    });

    it('retains no save replay after an unknown built-in create outcome', async () => {
        run.mockRejectedValueOnce(new Error('create acknowledgement lost after dispatch'));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.connect')?.props.onPress?.();
        });

        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();
        expect(run).toHaveBeenCalledOnce();
        const createRequest = run.mock.calls[0]?.[0] as { connectionId: string };
        const reviewCurrentState = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState');
        expect(reviewCurrentState).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();

        await React.act(async () => {
            reviewCurrentState?.props.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(routerPush).toHaveBeenCalledWith(
            `/(app)/settings/providers/${encodeURIComponent(createRequest.connectionId)}`,
        );
        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(run).toHaveBeenCalledOnce();
    });

    it('requires an exact daemon candidate, reviews its normalized destination, and never probes from the browser', async () => {
        describeProviderConnections
            .mockResolvedValueOnce({
                status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
                diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
                discoveryCandidatesTruncated: false,
                authoringPreview: {
                    status: 'selection_required', connectionId: 'pc_preview',
                    contributionKey: 'acme.plugin/ollama', created: true, credential: null,
                    candidates: [
                        {
                            candidateId: 'discovery-candidate:v1:first', scope: 'machine', machineId: 'machine-a',
                            endpoints: [{
                                endpointTemplateId: 'chat', protocol: 'openai-chat',
                                normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                            }],
                        },
                        {
                            candidateId: 'discovery-candidate:v1:second', scope: 'machine', machineId: 'machine-a',
                            endpoints: [{
                                endpointTemplateId: 'chat', protocol: 'openai-chat',
                                normalizedUrl: 'http://127.0.0.1:22434/v1', locality: 'loopback', scope: 'machine',
                            }],
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
                diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
                discoveryCandidatesTruncated: false,
                authoringPreview: {
                    status: 'resolved', connectionId: 'pc_preview',
                    contributionKey: 'acme.plugin/ollama', created: true,
                    candidateId: 'discovery-candidate:v1:second', scope: 'machine', machineId: 'machine-a',
                    endpoints: [{
                        endpointTemplateId: 'chat', protocol: 'openai-chat',
                        normalizedUrl: 'http://127.0.0.1:22434/v1', locality: 'loopback', scope: 'machine',
                    }],
                    credential: null,
                    fingerprint: 'authoring-review:v1:second', revision: 1,
                },
            });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const connect = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.connect');

        expect(connect?.props.onPress).toBeUndefined();
        expect(run).not.toHaveBeenCalled();

        await React.act(async () => {
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'http://127.0.0.1:22434/v1')
                ?.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        const rows = screen.findAllByType('Item');
        expect(rows.find((item) => item.props.title === 'settingsProviders.authoring.destinationScope')?.props.subtitle)
            .toBe('settingsProviders.authoring.destinationMachine · Mac');
        expect(rows.find((item) => item.props.title === 'openai-chat')?.props.subtitle)
            .toBe('http://127.0.0.1:22434/v1');
        await React.act(async () => {
            await rows.find((item) => item.props.title === 'settingsProviders.authoring.connect')?.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            authoringReview: {
                candidateId: 'discovery-candidate:v1:second',
                fingerprint: 'authoring-review:v1:second',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save');
        expect(probeProviderDraft).not.toHaveBeenCalled();
    });

    it('reviews and persists explicit remote endpoints on the same contribution identity', async () => {
        state.contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
        state.providerName = 'CLIProxyAPI';
        state.endpointTemplates = [
            { id: 'responses', protocol: 'openai-responses' },
            { id: 'anthropic', protocol: 'anthropic' },
        ];
        describeProviderConnections.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved',
                connectionId: 'pc_preview',
                contributionKey: state.contributionKey,
                created: true,
                candidateId: 'discovery-candidate:v1:local',
                scope: 'machine',
                machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                    normalizedUrl: 'http://127.0.0.1:8317/v1',
                    locality: 'loopback',
                    scope: 'machine',
                }, {
                    endpointTemplateId: 'anthropic',
                    protocol: 'anthropic',
                    normalizedUrl: 'http://127.0.0.1:8317/',
                    locality: 'loopback',
                    scope: 'machine',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:local',
                revision: 1,
            },
        }).mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved',
                connectionId: 'pc_preview',
                contributionKey: state.contributionKey,
                created: true,
                candidateId: null,
                scope: 'account',
                machineId: null,
                endpoints: [{
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                    normalizedUrl: 'https://remote.gateway.example/v1',
                    locality: 'public',
                    scope: 'account',
                }, {
                    endpointTemplateId: 'anthropic',
                    protocol: 'anthropic',
                    normalizedUrl: 'https://remote.gateway.example/',
                    locality: 'public',
                    scope: 'account',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:remote',
                revision: 1,
            },
        });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey={state.contributionKey} />,
        );

        const fields = screen.findAllByType('MachineSetupTextField');
        const responses = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-responses');
        const anthropic = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-anthropic');
        expect(responses).toBeDefined();
        expect(anthropic).toBeDefined();

        await React.act(async () => {
            responses?.props.onChangeText('https://remote.gateway.example/v1');
            anthropic?.props.onChangeText('https://remote.gateway.example');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        const endpointOverrides = [
            { endpointTemplateId: 'responses', baseUrl: 'https://remote.gateway.example/v1' },
            { endpointTemplateId: 'anthropic', baseUrl: 'https://remote.gateway.example/' },
        ];
        expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({
                contributionKey: state.contributionKey,
                selectedCandidateId: null,
                endpointOverrides,
            }),
        }));

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.connect')
                ?.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            contributionKey: state.contributionKey,
            authoringReview: {
                candidateId: null,
                fingerprint: 'authoring-review:v1:remote',
                revision: 1,
                endpointOverrides,
            },
        }), 'save');
    });

    it('progressively reveals all advanced protocol endpoints without a modal', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');
        expect(advanced).toBeDefined();
        await React.act(async () => {
            advanced?.props.rightElement.props.onValueChange(true);
        });
        expect(screen.findAllByType('ItemGroup').map((group) => group.props.title)).toEqual(expect.arrayContaining([
            'settingsProviders.authoring.protocol.openai-responses.title',
            'settingsProviders.authoring.protocol.openai-chat.title',
            'settingsProviders.authoring.protocol.anthropic.title',
            'settingsProviders.models.add',
        ]));
        const advancedSwitchRows = screen.findAllByType('Item').filter((item) => (
            item.props.title === 'settingsProviders.authoring.endpointEnabled'
            || item.props.title === 'settingsProviders.authoring.requiresApiKey'
        ));
        expect(advancedSwitchRows.length).toBeGreaterThan(0);
        expect(advancedSwitchRows
            .filter((row) => row.props.title === 'settingsProviders.authoring.endpointEnabled')
            .map((row) => row.props.rightElement.props.accessibilityLabel))
            .toEqual([
                'settingsProviders.authoring.protocol.openai-responses.title, settingsProviders.authoring.endpointEnabled',
                'settingsProviders.authoring.protocol.openai-chat.title, settingsProviders.authoring.endpointEnabled',
                'settingsProviders.authoring.protocol.anthropic.title, settingsProviders.authoring.endpointEnabled',
            ]);
    });

    it('returns an invalid advanced-header probe to its preserved draft without routing', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');

        await React.act(async () => {
            advanced?.props.rightElement.props.onValueChange(true);
        });
        const fields = screen.findAllByType('MachineSetupTextField');
        await React.act(async () => {
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Draft gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('http://127.0.0.1:38197');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.publicHeaders')
                ?.props.onChangeText('Authorization: forbidden');
        });
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await React.act(async () => { await test?.props.onPress?.(); });

        expect(probeProviderDraft).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.connectionInvalidTitle');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.reviewConnection');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.unreachableTitle');

        await React.act(async () => {
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewConnection')
                ?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.value)
            .toBe('Draft gateway');
        expect(screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.value)
            .toBe('http://127.0.0.1:38197');
        expect(screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.publicHeaders')?.props.value)
            .toBe('Authorization: forbidden');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.actions.reviewConnection');
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-base-url');
        expect(typeof screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.onPress)
            .toBe('function');
    });

    it('returns a malformed daemon probe response to its preserved draft without routing', async () => {
        probeProviderDraft.mockImplementationOnce(async (request: { draftConnectionId: string }) => ({
            status: 'error',
            error: createProviderErrorV1('provider_probe_response_invalid', {
                connectionId: request.draftConnectionId,
                machineId: 'machine-a',
            }),
        }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);

        await React.act(async () => {
            const fields = screen.findAllByType('MachineSetupTextField');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Malformed-response draft');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        await React.act(async () => {
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.detail.testConnection')
                ?.props.onPress?.();
            await Promise.resolve();
        });
        await React.act(async () => {
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewConnection')
                ?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.value)
            .toBe('Malformed-response draft');
        expect(screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.value)
            .toBe('https://gateway.example/v1');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.actions.reviewConnection');
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-base-url');
    });

    it('lets a successful active-guard save own the resulting Provider detail destination', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            await Promise.resolve();
        });

        expect(getActiveUnsavedChangesGuard()?.continueOnSave).toBe(false);
    });

    it('keeps or discards a dirty Provider draft through the shared navigation transaction', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Unsaved gateway');
        });

        expect(navigationPreventRemove.enabled).toBe(true);
        const action = { type: 'GO_BACK' };
        await React.act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const firstButtons = modalAlert.mock.calls.at(-1)?.[2] as Array<{
            style?: string;
            onPress?: () => void;
        }>;
        await React.act(async () => {
            firstButtons.find((button) => button.style === 'cancel')?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(navigationDispatch).not.toHaveBeenCalled();
        expect(navigationPreventRemove.enabled).toBe(true);

        await React.act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const secondButtons = modalAlert.mock.calls.at(-1)?.[2] as Array<{
            style?: string;
            onPress?: () => void;
        }>;
        await React.act(async () => {
            secondButtons.find((button) => button.style === 'destructive')?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(navigationDispatch).toHaveBeenCalledOnce();
        expect(navigationDispatch).toHaveBeenCalledWith(action);
        expect(run).not.toHaveBeenCalled();
    });

    it('keeps the required connection name visible, focusable, and continuous in advanced mode', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');
        const nameField = () => screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.authoring.name');

        await React.act(async () => { nameField()?.props.onChangeText('Company gateway'); });
        await React.act(async () => { advanced?.props.rightElement.props.onValueChange(true); });

        expect(nameField()?.props.value).toBe('Company gateway');
        await React.act(async () => { nameField()?.props.onChangeText(''); });
        const save = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.save');
        await React.act(async () => { await save?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        expect(nameField()?.props.errorText).toBeTruthy();
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-name');

        await React.act(async () => { nameField()?.props.onChangeText('Recovered gateway'); });
        await React.act(async () => { advanced?.props.rightElement.props.onValueChange(false); });
        expect(nameField()?.props.value).toBe('Recovered gateway');
    });

    it('labels every standalone authoring switch with its owning row', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const switchRows = screen.findAllByType('Item').filter((item) => (
            typeof item.props.rightElement?.props?.onValueChange === 'function'
        ));

        expect(switchRows.length).toBeGreaterThan(0);
        for (const row of switchRows) {
            expect(row.props.rightElement.props.accessibilityLabel).toBe(row.props.title);
        }
    });

    it('sends initial manual models inside the one create mutation', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType('MachineSetupTextField');
        await React.act(async () => {
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.onChangeText('Anthropic bridge');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/anthropic');
            fields.find((field) => field.props.label === 'settingsProviders.models.addFieldLabel')?.props.onChangeText('first/model\nsecond/model');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        const save = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.authoring.save');
        await React.act(async () => { await save?.props.onPress?.(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createCustom',
            manualModels: [{ id: 'first/model' }, { id: 'second/model' }],
        }), 'save');
    });

    it('retains no save replay after an unknown custom create outcome', async () => {
        run.mockRejectedValueOnce(new Error('create acknowledgement lost after dispatch'));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType('MachineSetupTextField');
        await React.act(async () => {
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.onChangeText('Gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.save')?.props.onPress?.();
        });

        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();
        expect(run).toHaveBeenCalledOnce();
        const createRequest = run.mock.calls[0]?.[0] as { connectionId: string };
        const reviewCurrentState = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState');
        expect(reviewCurrentState).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();

        await React.act(async () => {
            reviewCurrentState?.props.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(routerPush).toHaveBeenCalledWith(
            `/(app)/settings/providers/${encodeURIComponent(createRequest.connectionId)}`,
        );
        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(run).toHaveBeenCalledOnce();
        expect(focusField).not.toHaveBeenCalled();
    });

    it('blocks custom creation and marks rejected manual model lines inline', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType('MachineSetupTextField');
        await React.act(async () => {
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.onChangeText('Gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/v1');
            fields.find((field) => field.props.label === 'settingsProviders.models.addFieldLabel')?.props.onChangeText('valid-model\nbad model');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });

        const save = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.authoring.save');
        await React.act(async () => { await save?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        const manualModels = screen.findAllByType('MachineSetupTextField')
            .find((field) => field.props.label === 'settingsProviders.models.addFieldLabel');
        expect(manualModels?.props.errorText).toBeTruthy();
        expect(focusField).toHaveBeenCalledWith('provider-manual-model-ids');
    });

    it('shows exact machine-scoped confirmation for a local address and respects disabled save intent', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType('MachineSetupTextField');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')?.props.onChangeText('Local gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('http://127.0.0.1:1234/v1');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        const localNotice = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.localAddressTitle');
        expect(localNotice?.props.subtitle).toEqual({
            key: 'settingsProviders.authoring.localAddressDescription',
            params: { machine: 'Mac', endpoint: 'http://127.0.0.1:1234/v1' },
        });
        const enable = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving');
        await React.act(async () => { enable?.props.rightElement.props.onValueChange(false); });
        const save = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.authoring.save');
        await React.act(async () => { await save?.props.onPress?.(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'createCustom', enable: false }), 'save');
    });

    it('ignores a probe response that completes after the draft changes', async () => {
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderDraft.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const requiresApiKey = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey');
        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://initial.example/v1');
            requiresApiKey?.props.rightElement.props.onValueChange(false);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await React.act(async () => { test?.props.onPress?.(); });
        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://changed.example/v1');
        });
        await React.act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });
        const refreshedTest = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(refreshedTest?.props.subtitle).toBe('settingsProviders.detail.testDescription');
        expect(refreshedTest?.props.loading).toBe(false);
    });

    it('retains successful Test connection truth across a display-only rename', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const requiresApiKey = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey');
        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            requiresApiKey?.props.rightElement.props.onValueChange(false);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(typeof test?.props.onPress).toBe('function');
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(probeProviderDraft).toHaveBeenCalledOnce();
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Renamed gateway');
        });

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');
    });

    it('invalidates successful Test connection truth after the manual model list changes', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType('MachineSetupTextField');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.models.addFieldLabel')
                ?.props.onChangeText('model-after-success');
        });

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('invalidates successful Test connection truth after the selected Saved Secret value rotates', async () => {
        state.savedSecrets = [{
            id: 'secret-a',
            name: 'Gateway key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVyLWE=' } },
            createdAt: 1,
            updatedAt: 1,
        }];
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType('MachineSetupTextField');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            fields.find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.authoring.apiKey')
                ?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as { props?: { onSelectId?: (id: string | null) => void } } | undefined;
        await React.act(async () => {
            picker?.props?.onSelectId?.('secret-a');
        });
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await React.act(async () => {
            state.savedSecrets = [{
                ...state.savedSecrets[0]!,
                encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVyLWI=' } },
                updatedAt: 2,
            }];
            savedSecretListeners.forEach((listener) => listener());
        });

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('renders a thrown probe failure as typed retry recovery without invoking save', async () => {
        probeProviderDraft
            .mockRejectedValueOnce(new Error('socket implementation detail'))
            .mockResolvedValueOnce({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:retry' });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const test = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');

        await React.act(async () => {
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Retry gateway');
            screen.findAllByType('MachineSetupTextField')
                .find((field) => field.props.label === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://models.example/v1');
        });
        await React.act(async () => { await test?.props.onPress?.(); });
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.unreachableTitle');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');
        expect(run).not.toHaveBeenCalled();
    });
});
