import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS, type DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';

import {
    createProviderModelProjectionFixture,
    createProviderModelProjectionGroupFixture,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
    installProviderSettingsStorageBoundary,
    renderScreen,
} from '@/dev/testkit';

const mocks = vi.hoisted(() => ({
    settings: { schemaVersion: 7, providerSettingsV1: { v: 99, connections: [] } } as unknown,
    mutate: vi.fn(),
    refresh: vi.fn(async () => {}),
    projectionRequestCount: 0,
    projection: {
        data: null as Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> | null,
        loading: false,
        error: null as null | ReturnType<typeof createProviderErrorV1>,
    },
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
installProviderSettingsStorageBoundary(providerHarness);

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: routerPush }) }));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'server-a' }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));

describe('AgentModelsScreen provider settings safety', () => {
    beforeEach(() => {
        providerHarness.reset();
        mocks.settings = { schemaVersion: 7, providerSettingsV1: { v: 99, connections: [] } };
        mocks.projection = { data: null, loading: false, error: null };
        mocks.projectionRequestCount = 0;
        mocks.mutate.mockReset();
        routerPush.mockReset();
        providerHarness.state.settings = mocks.settings;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => {
            mocks.projectionRequestCount += 1;
            if (mocks.projection.loading && !mocks.projection.data) return await new Promise<never>(() => undefined);
            if (mocks.projection.error) return { status: 'error', error: mocks.projection.error };
            return mocks.projection.data ?? createProviderModelProjectionFixture({ agentTargetKey: 'backend:codex' });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE, async (request, next) => (
            await mocks.mutate({ serverId: 'server-a', request: request.payload }) ?? await next()
        ));
    });

    it('renders projected rows supplied through the shared Provider RPC boundary and real manager', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.settings = { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
        providerHarness.state.settings = mocks.settings;
        mocks.projection.data = createProviderModelProjectionFixture({
                groups: [createProviderModelProjectionGroupFixture({
                    rows: [{
                        ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'boundary-model' },
                        descriptor: { id: 'boundary-model', name: 'Boundary agent model' },
                        sources: { manual: false, static: true, probe: false },
                        confidence: 'verified_static',
                        compatibility: {
                            result: { status: 'verified', selectedProtocol: 'openai-chat', evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' } },
                            compatibilityFingerprint: 'compatibility:v1:boundary',
                            confirmed: true,
                        },
                        endpointHealth: 'available',
                        catalog: { stale: false },
                        loadState: 'loaded',
                        visibility: 'visible',
                    }],
                })],
            });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />);

        expect(screen.findByType(ProviderModelManager).props.groups[0].rows[0].descriptor.name)
            .toBe('Boundary agent model');
    });
    it('renders a read-only diagnostic for future provider settings instead of a mutable default manager', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />,
        );
        expect(screen.findByTestId('agent-models')).toBeNull();
        expect(screen.getTextContent()).toContain('Provider needs attention');
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('shows explicit first-load and structured failure states instead of an empty manager', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        mocks.settings = { schemaVersion: 7 };
        providerHarness.state.settings = mocks.settings;
        mocks.projection = { data: null, loading: true, error: null };
        const loading = await renderScreen(<AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />);
        expect(loading.findByTestId('agent-models')).toBeNull();
        expect(loading.getTextContent()).toContain('Loading');

        mocks.projection = {
            data: null,
            loading: false,
            error: createProviderErrorV1('provider_endpoint_unreachable'),
        };
        const failed = await renderScreen(<AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />);
        expect(failed.findByTestId('agent-models')).toBeNull();
        expect(failed.getTextContent()).toContain('Provider is unreachable');
    });

    it.each(['native visibility', 'agent reset', 'mixed bulk'] as const)(
        'reconciles a commit-then-reject %s once and reviews the current Agent Models surface',
        async (operation) => {
            const { AgentModelsScreen } = await import('./AgentModelsScreen');
            const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
            mocks.settings = { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
            providerHarness.state.settings = mocks.settings;
            mocks.projection.data = createProviderModelProjectionFixture({
                groups: [createProviderModelProjectionGroupFixture({
                    rows: [{
                        ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'provider-model' },
                        descriptor: { id: 'provider-model', name: 'Provider model' },
                        sources: { manual: false, static: true, probe: false },
                        confidence: 'verified_static',
                        compatibility: {
                            result: {
                                status: 'verified', selectedProtocol: 'openai-chat',
                                evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' },
                            },
                            compatibilityFingerprint: 'compatibility:v1:agent-review',
                            confirmed: true,
                        },
                        endpointHealth: 'available',
                        catalog: { stale: false },
                        loadState: 'loaded',
                        visibility: 'visible',
                    }],
                })],
            });
            mocks.mutate.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
            const screen = await renderScreen(
                <AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId="claude" />,
            );
            expect(mocks.projectionRequestCount).toBe(1);
            const manager = screen.findByType(ProviderModelManager);

            await act(async () => {
                if (operation === 'native visibility') {
                    manager.props.onSetVisibility?.({
                        scope: 'agent', agentTargetKey: 'backend:codex',
                        providerConnectionId: null, modelId: 'native-model',
                    }, true);
                } else if (operation === 'agent reset') {
                    manager.props.onResetVisibility?.();
                } else {
                    manager.props.onShowAll?.();
                }
                await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
            });
            await act(async () => {
                await vi.waitFor(() => expect(
                    screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
                ).not.toBeNull());
            });

            expect(mocks.mutate).toHaveBeenCalledOnce();
            if (operation === 'mixed bulk') {
                const changes = mocks.mutate.mock.calls[0]?.[0].request.changes;
                expect(changes.some((change: { ref: { providerConnectionId: string | null } }) => change.ref.providerConnectionId === null)).toBe(true);
                expect(changes.some((change: { ref: { providerConnectionId: string | null } }) => change.ref.providerConnectionId === 'pc_a')).toBe(true);
            }
            const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
            expect(reviewAction).not.toBeNull();
            expect(screen.getTextContent()).not.toContain('Retry');
            expect(screen.findByType(ProviderModelManager)).toBeDefined();

            await act(async () => {
                await reviewAction?.props.onPress?.();
                await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
            });
            expect(mocks.mutate).toHaveBeenCalledOnce();
            expect(routerPush).not.toHaveBeenCalled();
        },
    );

    it('reviews an ambiguous model load on Agent Models without retaining load replay', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.settings = { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
        providerHarness.state.settings = mocks.settings;
        mocks.projection.data = createProviderModelProjectionFixture({
            groups: [createProviderModelProjectionGroupFixture({
                modelLoadAction: 'available',
                rows: [{
                    ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'provider-model' },
                    descriptor: { id: 'provider-model', name: 'Provider model' },
                    sources: { manual: false, static: true, probe: false },
                    confidence: 'verified_static',
                    compatibility: {
                        result: {
                            status: 'verified', selectedProtocol: 'openai-chat',
                            evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' },
                        },
                        compatibilityFingerprint: 'compatibility:v1:agent-load-review',
                        confirmed: true,
                    },
                    endpointHealth: 'available',
                    catalog: { stale: false },
                    loadState: 'unloaded',
                    visibility: 'visible',
                }],
            })],
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, async () => {
            throw new Error('load acknowledgement lost while daemon work continues');
        });
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />,
        );

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'provider-model');
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
            ).not.toBeNull());
        });
        const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
        expect(reviewAction).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Retry');
        expect(screen.getTextContent()).not.toContain('Load model');
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        )).toHaveLength(1);

        await act(async () => {
            await reviewAction?.props.onPress?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
        });
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        )).toHaveLength(1);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('retries only projection refresh after an acknowledged settings mutation', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.settings = { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
        providerHarness.state.settings = mocks.settings;
        mocks.projection.data = createProviderModelProjectionFixture({ agentTargetKey: 'backend:codex' });
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="backend:codex" runtimeAgentId={null} />,
        );
        mocks.projection.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onResetVisibility?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error-action:provider_endpoint_unavailable'),
            ).not.toBeNull());
        });
        expect(mocks.mutate).toHaveBeenCalledOnce();
        const retryRefreshAction = screen.findByTestId('provider-error-action:provider_endpoint_unavailable');
        expect(retryRefreshAction).not.toBeNull();

        await act(async () => {
            await retryRefreshAction?.props.onPress?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
        });
        expect(mocks.mutate).toHaveBeenCalledOnce();
    });
});
