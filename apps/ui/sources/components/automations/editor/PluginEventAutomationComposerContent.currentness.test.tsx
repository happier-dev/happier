import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { getPluginExecutionOriginCandidateOrigin, type PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';

import type { PluginEventAutomationComposerModel } from './usePluginEventAutomationComposer';
import { readPluginEventAutomationWatcherFailure } from './pluginEventAutomationObservationBinding';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installAutomationComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

vi.mock('@/components/plugins/shared/installedPluginBrandPresentation', () => ({
    useInstalledPluginBrandPresentation: () => null,
}));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => null,
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');

function createModel(options: Readonly<{
    eventAvailable?: boolean;
    watcherCurrent?: boolean;
    filterValid?: boolean;
    maximumObservationAgeMsValid?: boolean;
    webhookEndpoint?: PluginEventAutomationComposerModel['webhookEndpoint'];
    refreshWebhookEndpoint?: PluginEventAutomationComposerModel['refreshWebhookEndpoint'];
    webhookEndpointRefreshing?: boolean;
}> = {}): PluginEventAutomationComposerModel {
    const eventAvailable = options.eventAvailable ?? false;
    const watcherCurrent = options.watcherCurrent ?? true;
    const filterValid = options.filterValid ?? true;
    const maximumObservationAgeMsValid = options.maximumObservationAgeMsValid ?? true;
    const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: 'acme.github/events/repository',
            identity: { pluginId: 'acme.github', localId: 'events/repository' },
            occurrenceId: 'event-occurrence-a',
            sourceCustody: { kind: 'development', registeredRootId: 'event-root-a' },
            title: 'Repository changed',
            description: 'A repository changed',
            payloadSchema: {
                type: 'object',
                properties: { action: { type: 'string' } },
                additionalProperties: false,
            },
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: { type: 'object', additionalProperties: false },
                    setupActionRef: { pluginId: 'acme.github', localId: 'setup-source' },
                },
            },
        },
        setupAction: {
            id: 'acme.github/setup-source',
            identity: { pluginId: 'acme.github', localId: 'setup-source' },
            occurrenceId: 'event-occurrence-a',
            title: 'Set up source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
    });
    const watcherCandidates = [{
        materialization: {
            serverIdentityId: 'srv_account_a',
            machineId: 'watcher-machine',
            materializationId: 'github-materialization',
            pluginId: 'acme.github',
            version: '1.0.0',
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 100,
        },
        releaseContent: 'matched',
        validation: watcherCurrent ? { kind: 'admitted' } : { kind: 'rejected', reason: 'offline' },
    }] satisfies readonly PluginMachineExecutionOriginCandidateV1[];

    return {
        eligibleEvents: [event],
        eventCatalogStatus: 'ready',
        selectedEvent: event,
        selectEvent: vi.fn(),
        getEventPresentation: (candidate: { event: { title: string; description: string | null } }) => ({ title: candidate.event.title, description: candidate.event.description }),
        getPluginPresentation: () => ({
            eventKey: 'acme.github:events/repository',
            displayName: 'Acme GitHub',
            availability: eventAvailable ? 'available' : 'unavailable',
            installedPackage: null,
            expectedOccurrenceId: null,
            machineId: null,
            serverId: null,
            accountLifetime: null,
            isCurrent: () => false,
        }),
        sourceStatus: 'configured',
        sourceFailure: null,
        sourceDisplayLabel: 'acme/widgets',
        sourceInstanceId: 'repository:42',
        availableObservationTransports: ['checkpointedPull'],
        observationTransport: 'checkpointedPull',
        setObservationTransport: vi.fn(),
        webhookEndpoint: options.webhookEndpoint ?? null,
        refreshWebhookEndpoint: options.refreshWebhookEndpoint ?? null,
        webhookEndpointRefreshing: options.webhookEndpointRefreshing ?? false,
        configureSource: vi.fn(),
        watcherCandidates,
        watcherFailures: watcherCandidates.flatMap(candidate => {
            const failure = readPluginEventAutomationWatcherFailure(candidate, event);
            return failure ? [{ ...failure, origin: getPluginExecutionOriginCandidateOrigin(candidate) }] : [];
        }),
        selectedWatcherOrigin: {
            serverIdentityId: 'srv_account_a',
            materializationRef: {
                machineId: 'watcher-machine',
                materializationId: 'github-materialization',
                pluginId: 'acme.github',
            },
        },
        selectWatcher: vi.fn(),
        payloadBrowser: {
            fields: [{ pointer: '/action', label: 'Action', scalarKind: 'string', sampleValue: 'opened' }],
            samplePayload: { action: 'opened' },
        },
        filterClauses: [],
        addFilterClause: vi.fn(),
        removeFilterClause: vi.fn(),
        setFilterClauseField: vi.fn(),
        setFilterClauseOperator: vi.fn(),
        setFilterClauseValueText: vi.fn(),
        filterValid,
        maximumObservationAgeMsText: '',
        setMaximumObservationAgeMsText: vi.fn(),
        maximumObservationAgeMsValid,
        createDraft: null,
        invalidateConfiguredSource: vi.fn(),
        revision: 0,
    };
}

describe('PluginEventAutomationComposerContent currentness', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps a retained selection pending while its catalog and watcher candidates load', async () => {
        const current = createModel({ eventAvailable: true });
        const model: PluginEventAutomationComposerModel = { ...current, eventCatalogStatus: 'loading', watcherCandidates: [],
            getPluginPresentation: event => ({ ...current.getPluginPresentation(event), availability: 'loading' }) };
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);
        expect(screen.getTextContent()).toContain('automations.form.trigger.eventCatalogLoading');
        expect(screen.getTextContent()).not.toContain('automations.form.trigger.sourceUnavailable');
    });

    it('offers only the existing watcher chooser for pending Event intent before catalog admission', async () => {
        const current = createModel();
        const model = { ...current, eligibleEvents: [], selectedEvent: null, selectedWatcherOrigin: null,
            eventCatalogStatus: 'unavailable' as const, pendingEventRef: current.selectedEvent!.event.identity };
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);
        expect(screen.findByTestId('automation-event-watcher-picker')).not.toBeNull();
        expect(screen.findByTestId('automation-event-configure-source')).toBeNull();
        expect(screen.findByTestId('automation-event-filter-add-clause')).toBeNull();
        expect(model.configureSource).not.toHaveBeenCalled();
    });

    it('stops disclosing the one-time webhook secret once the configured source is no longer current', async () => {
        const webhookEndpoint = {
            publicUrl: 'https://ingress.example/hooks/abc',
            oneTimeGeneratedSecret: 'whsec-account-a-private',
        } as PluginEventAutomationComposerModel['webhookEndpoint'];

        // A live configured source is exactly where this credential is meant
        // to be readable, so the negative below cannot pass for a composer that
        // never renders it at all.
        const live = await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({ eventAvailable: true, watcherCurrent: true, webhookEndpoint })}
            />,
        );
        expect(live.findByTestId('automation-event-webhook-endpoint-secret')?.props.children)
            .toBe('whsec-account-a-private');
        expect(live.getTextContent()).toContain('whsec-account-a-private');

        // The same retained `configured` state whose event/watcher binding is no
        // longer current — the shape an Account or target change leaves behind.
        const stale = await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({ eventAvailable: false, watcherCurrent: true, webhookEndpoint })}
            />,
        );
        expect(stale.findByTestId('automation-event-webhook-endpoint')).toBeNull();
        expect(stale.getTextContent()).not.toContain('whsec-account-a-private');
    });

    it('offers a recheck beside the unconfirmed webhook alert and withdraws both once it reports ready', async () => {
        const refreshWebhookEndpoint = vi.fn();
        const endpoint = (readiness: string) => ({
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness,
            oneTimeGeneratedSecret: null,
        } as PluginEventAutomationComposerModel['webhookEndpoint']);

        const unconfirmed = await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({
                    eventAvailable: true,
                    webhookEndpoint: endpoint('providerConfirmationRequired'),
                    refreshWebhookEndpoint,
                })}
            />,
        );
        expect(unconfirmed.findByTestId('automation-event-webhook-endpoint-readiness')).not.toBeNull();
        const recheck = unconfirmed.findByProps({ testID: 'automation-event-webhook-endpoint-recheck' });
        expect(recheck.props.disabled).toBe(false);
        recheck.props.onPress();
        expect(refreshWebhookEndpoint).toHaveBeenCalledTimes(1);

        // Provider setup happens outside this composer, so the recheck is the
        // only way the alert can ever clear. Once the canonical owner reports
        // a working delivery path, both the alert and its recheck withdraw.
        const ready = await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({
                    eventAvailable: true,
                    webhookEndpoint: endpoint('ready'),
                    refreshWebhookEndpoint,
                })}
            />,
        );
        expect(ready.findByTestId('automation-event-webhook-endpoint')).not.toBeNull();
        expect(ready.findByTestId('automation-event-webhook-endpoint-readiness')).toBeNull();
        expect(ready.findByTestId('automation-event-webhook-endpoint-recheck')).toBeNull();
    });

    it('marks the webhook recheck busy rather than admitting a second concurrent reread', async () => {
        const refreshWebhookEndpoint = vi.fn();

        const screen = await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({
                    eventAvailable: true,
                    webhookEndpoint: {
                        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ',
                        publicUrl: 'https://ingress.example/hooks/abc',
                        readiness: 'providerConfirmationRequired',
                        oneTimeGeneratedSecret: null,
                    } as PluginEventAutomationComposerModel['webhookEndpoint'],
                    refreshWebhookEndpoint,
                    webhookEndpointRefreshing: true,
                })}
            />,
        );

        const recheck = screen.findByProps({ testID: 'automation-event-webhook-endpoint-recheck' });
        expect(recheck.props.disabled).toBe(true);
        expect(screen.findHostByTestId('automation-event-webhook-endpoint-recheck')?.props.accessibilityState)
            .toMatchObject({ busy: true, disabled: true });
    });

    it('does not present a stale configured source as ready to reconfigure', async () => {

        const screen = await renderScreen(<PluginEventAutomationComposerContent model={createModel()} />);

        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.children)
            .toBe('automations.form.trigger.sourceUnavailable');
    });

    it('keeps the recovery state honest when the selected watcher is no longer admitted', async () => {

        const screen = await renderScreen(
            <PluginEventAutomationComposerContent model={createModel({ eventAvailable: true, watcherCurrent: false })} />,
        );

        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.children)
            .toBe('automations.form.trigger.sourceUnavailable');
    });

    it('does not invite a source setup Action while the Event filter is invalid', async () => {

        const screen = await renderScreen(
            <PluginEventAutomationComposerContent model={createModel({
                eventAvailable: true,
                filterValid: false,
            })}
            />,
        );

        const configure = screen.findByProps({ testID: 'automation-event-configure-source' });
        expect(configure.props.disabled).toBe(true);
        expect(screen.findHostByTestId('automation-event-configure-source')?.props.accessibilityState)
            .toMatchObject({ disabled: true });
        expect(configure.props.accessibilityHint).toBe('automations.form.trigger.eventFilterInvalid');
        expect(screen.findAllByProps({ testID: 'automation-event-source-unavailable' })).toHaveLength(0);
    });
});

describe('PluginEventAutomationComposerContent webhook endpoint readiness', () => {
    afterEach(() => {
        standardCleanup();
    });

    async function renderWithEndpoint(
        endpoint: PluginEventAutomationComposerModel['webhookEndpoint'],
    ): Promise<Awaited<ReturnType<typeof renderScreen>>> {
        return await renderScreen(
            <PluginEventAutomationComposerContent
                model={createModel({ eventAvailable: true, watcherCurrent: true, webhookEndpoint: endpoint })}
            />,
        );
    }

    it('discloses that a disclosed endpoint is not a delivery path until the provider confirms it', async () => {
        const awaitingConfirmation = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'providerConfirmationRequired',
            oneTimeGeneratedSecret: 'whsec-account-a-private',
        });
        expect(awaitingConfirmation
            .findByTestId('automation-event-webhook-endpoint-readiness')?.props.children)
            .toBe('automations.form.trigger.webhookEndpointAwaitingConfirmation');

        // The positive twin: the identical endpoint whose provider already
        // delivered must not repeat the instruction, so the disclosure cannot
        // be a constant that is always rendered.
        const confirmed = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'ready',
            oneTimeGeneratedSecret: null,
        });
        expect(confirmed.findByTestId('automation-event-webhook-endpoint-readiness')).toBeNull();
        expect(confirmed.getTextContent())
            .not.toContain('automations.form.trigger.webhookEndpointAwaitingConfirmation');
    });

    it('does not demand a credential rotation for an endpoint the provider already confirmed', async () => {
        // A re-read of an existing endpoint never re-discloses the secret, so a
        // null secret alone cannot mean provider setup is still blocked.
        const confirmed = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'ready',
            oneTimeGeneratedSecret: null,
        });
        expect(confirmed.findByTestId('automation-event-webhook-endpoint-secret-lost')).toBeNull();

        // The state that genuinely does require a rotation still says so.
        const disclosureLost = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'credentialDisclosureLost',
            oneTimeGeneratedSecret: null,
        });
        expect(disclosureLost.findByTestId('automation-event-webhook-endpoint-secret-lost')?.props.children)
            .toBe('automations.form.trigger.webhookEndpointSecretLost');
    });

    it('does not label a secret field that has nothing to show under it', async () => {
        // Suppressing the rotation instruction for a confirmed endpoint must not
        // leave its "SECRET (SHOWN ONCE)" label standing over an empty field.
        const confirmed = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'ready',
            oneTimeGeneratedSecret: null,
        });
        expect(confirmed.getTextContent())
            .not.toContain('automations.form.trigger.webhookEndpointSecret');

        // The label still introduces a field that does have content.
        const disclosed = await renderWithEndpoint({
            webhookEndpointId: 'whep_a',
            publicUrl: 'https://ingress.example/hooks/abc',
            readiness: 'providerConfirmationRequired',
            oneTimeGeneratedSecret: 'whsec-account-a-private',
        });
        expect(disclosed.getTextContent())
            .toContain('automations.form.trigger.webhookEndpointSecret');
    });
    it('speaks to people: the watcher by its Machine name and payload fields by label; raw ids and JSON only under Technical details (#184 F3)', async () => {
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={createModel({ eventAvailable: true })} />);
        const text = screen.getTextContent();
        // Raw identifiers and the sample JSON never read as the editor's words.
        for (const raw of ['watcher-machine', 'github-materialization', 'acme.github', '/action', '"action"']) {
            expect(text).not.toContain(raw);
        }
        expect(text).toContain('Action');
        // They remain reachable on request, behind the one Technical details fold.
        expect(screen.findByTestId('automation-event-technical-details')).not.toBeNull();
    });
});
