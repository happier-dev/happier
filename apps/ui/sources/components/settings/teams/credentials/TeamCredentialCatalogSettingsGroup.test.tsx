import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup } from '@/dev/testkit';

import { TeamCredentialCatalogSettingsGroup } from './TeamCredentialCatalogSettingsGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';

afterEach(standardCleanup);

describe('TeamCredentialCatalogSettingsGroup', () => {
    it('keeps the rail heading a name and explains a cold catalog failure beside one retry', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(<TeamCredentialCatalogSettingsGroup title="Provided by Teams" variant="rail" sourceKind="provider"
            catalog={{ resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: false,
                condition: { reason: 'offline', retryable: true }, reload: async () => undefined }}
            onRetry={onRetry} onOpen={() => undefined} />);
        expect(screen.findAllByType(CollectionListGroupLabel)[0]?.props.title).toBe('Provided by Teams');
        expect(screen.findAllByType(CollectionListGroupLabel)[0]?.props.count).toBeUndefined();
        expect(screen.getTextContent()).not.toContain('0');
        const state = screen.findAllByType(SurfaceStateCard)[0];
        expect(state?.props).toMatchObject({ kind: 'unavailable', size: 'line' });
        expect(state?.props.reason).toBe(t('teams.unavailable.offline'));
        await React.act(async () => { await state?.props.action.onPress(); });
        expect(onRetry).toHaveBeenCalledOnce();
        expect(screen.getTextContent()).not.toContain('Showing the last known data for this Home.');
    });

    it('withholds an unknown zero during loading and keeps a confirmed empty catalog absent', async () => {
        const catalog = { resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set<string>(),
            current: false, condition: { reason: 'loading' as const, retryable: false }, reload: async () => undefined };
        const screen = await renderScreen(<TeamCredentialCatalogSettingsGroup title="Provided by Teams" variant="rail" sourceKind="provider"
            catalog={catalog} onOpen={() => undefined} />);
        expect(screen.findAllByType(CollectionListGroupLabel)[0]?.props.count).toBeUndefined();
        expect(screen.getTextContent()).not.toContain('0');
        expect(screen.findAllByType(SurfaceStateCard)[0]?.props.kind).toBe('loading');

        await screen.update(<TeamCredentialCatalogSettingsGroup title="Provided by Teams" variant="rail" sourceKind="provider"
            catalog={{ ...catalog, current: true, condition: null }} onOpen={() => undefined} />);
        expect(screen.getTextContent()).toBe('');
    });
    it('shows one applicable least-privilege resource and opens it by canonical identity', async () => {
        const onOpen = vi.fn();
        const provider = {
            id: 'resource-provider', teamId: 'team-1', displayName: 'Acme Provider', resourceRevision: 7,
            readiness: { kind: 'available' as const }, recoveryAction: null, deliveryMode: 'brokered' as const,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const, providerModels: [], connectedServiceSelections: [],
            sourcePresentation: {
                kind: 'provider' as const,
                provider: { identity: { pluginId: 'openrouter', localId: 'openrouter' }, definitionRevision: 1 as const },
            },
        };
        const connected = {
            ...provider,
            id: 'resource-connected',
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'github', localId: 'github' },
            },
        };
        const screen = await renderScreen(
            <TeamCredentialCatalogSettingsGroup
                title="Provided by Teams"
                sourceKind="provider"
                catalog={{
                    resources: [provider, provider, connected],
                    teamNameById: { 'team-1': 'Acme' },
                    homeNameByTeamId: { 'team-1': 'Home A' },
                    currentResourceKeys: new Set(['team-1:resource-provider', 'team-1:resource-connected']),
                    current: true,
                    condition: null,
                    reload: async () => undefined,
                }}
                onOpen={onOpen}
            />,
        );

        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toEqual(['team-credential-catalog-resource:team-1:resource-provider']);
        screen.pressByTestId('team-credential-catalog-resource:team-1:resource-provider');
        expect(onOpen).toHaveBeenCalledWith(provider);
    });

    it('retains stale rows but prevents navigation until exact currentness returns', async () => {
        const onOpen = vi.fn();
        const onRetry = vi.fn();
        const resource = {
            id: 'resource-provider', teamId: 'team-1', displayName: 'Acme Provider', resourceRevision: 7,
            readiness: { kind: 'available' as const }, recoveryAction: 'retry' as const, deliveryMode: 'direct' as const,
            mayBroker: false, mayReceiveDirect: true, directMaterialState: 'stale' as const,
            sessionUsePolicy: 'personal_allowed' as const, providerModels: [], connectedServiceSelections: [],
            sourcePresentation: {
                kind: 'provider' as const,
                provider: { identity: { pluginId: 'openrouter', localId: 'openrouter' }, definitionRevision: 1 as const },
            },
        };
        const screen = await renderScreen(
            <TeamCredentialCatalogSettingsGroup
                title="Provided by Teams"
                variant="rail"
                sourceKind="provider"
                catalog={{
                    resources: [resource], teamNameById: { 'team-1': 'Acme' },
                    homeNameByTeamId: { 'team-1': 'Home A' }, currentResourceKeys: new Set(), current: false, condition: { reason: 'offline', retryable: true },
                    reload: async () => undefined,
                }}
                onRetry={onRetry}
                onOpen={onOpen}
            />,
        );

        expect(screen.getTextContent()).toContain('Showing the last known data for this Home.');
        expect(screen.findAllByType(CollectionListGroupLabel)[0]?.props.count).toBe(1);
        expect(screen.findByTestId('team-credential-catalog-resource:team-1:resource-provider')?.props.onPress).toBeUndefined();
        screen.pressByTestId('team-credential-catalog-stale:provider-action');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps an empty unavailable catalog actionable instead of claiming retained data', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <TeamCredentialCatalogSettingsGroup
                title="Provided by Teams"
                sourceKind="provider"
                catalog={{
                    resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: false, condition: { reason: 'offline', retryable: true },
                    reload: async () => undefined,
                }}
                onRetry={onRetry}
                onOpen={() => undefined}
            />,
        );

        expect(screen.getTextContent()).toContain(t('teams.unavailable.offline'));
        expect(screen.getTextContent()).not.toContain(t('teams.stale.label'));
        screen.pressByTestId('team-credential-catalog-retry:provider');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not show a disabled catalog as last-known data', async () => {
        const screen = await renderScreen(
            <TeamCredentialCatalogSettingsGroup
                title="Shared with you"
                sourceKind="connected_service"
                catalog={{
                    resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: false, condition: null,
                    reload: async () => undefined,
                }}
                onRetry={() => undefined}
                onOpen={() => undefined}
            />,
        );

        expect(screen.getTextContent()).toBe('');
    });

    it('keeps an exact current repair row reachable while another catalog slice is stale', async () => {
        const onOpen = vi.fn();
        const resource = {
            id: 'resource-provider', teamId: 'team-1', displayName: 'Acme Provider', resourceRevision: 7,
            readiness: { kind: 'source_unavailable' as const }, recoveryAction: 'retry' as const,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'stale' as const, sessionUsePolicy: 'personal_allowed' as const, providerModels: [], connectedServiceSelections: [],
            sourcePresentation: {
                kind: 'provider' as const,
                provider: { identity: { pluginId: 'openrouter', localId: 'openrouter' }, definitionRevision: 1 as const },
            },
        };
        const screen = await renderScreen(
            <TeamCredentialCatalogSettingsGroup
                title="Provided by Teams"
                sourceKind="provider"
                catalog={{
                    resources: [resource], teamNameById: { 'team-1': 'Acme' }, homeNameByTeamId: { 'team-1': 'Home A' },
                    currentResourceKeys: new Set(['team-1:resource-provider']), current: false, condition: null,
                    reload: async () => undefined,
                }}
                onOpen={onOpen}
            />,
        );

        screen.pressByTestId('team-credential-catalog-resource:team-1:resource-provider');
        expect(onOpen).toHaveBeenCalledWith(resource);
    });
});
