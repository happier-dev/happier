import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { InlinePluginEventEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import type { PluginEventAutomationComposerModel } from '@/components/automations/editor/usePluginEventAutomationComposer';
import type { PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { getPluginExecutionOriginCandidateOrigin } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { readPluginEventAutomationWatcherFailure } from '@/components/automations/editor/pluginEventAutomationObservationBinding';

const noop = () => {};

const EVENT = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
    event: {
        id: 'happier.github/events/pull-request',
        identity: { pluginId: 'happier.github', localId: 'events/pull-request' },
        occurrenceId: 'specimen-occurrence',
        sourceCustody: { kind: 'development', registeredRootId: 'specimen-root' },
        title: 'Pull request opened',
        description: 'A pull request was opened or reopened',
        payloadSchema: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: false },
        automation: {
            v: 1,
            eligible: true,
            source: {
                sourceContractVersion: 1,
                supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: { type: 'object', additionalProperties: false },
                setupActionRef: { pluginId: 'happier.github', localId: 'setup-source' },
            },
        },
    },
    setupAction: {
        id: 'happier.github/setup-source',
        identity: { pluginId: 'happier.github', localId: 'setup-source' },
        occurrenceId: 'specimen-occurrence',
        title: 'Set up source',
        description: null,
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
    },
});

function candidate(machineId: string, version: string,
    validation: PluginMachineExecutionOriginCandidateV1['validation']): PluginMachineExecutionOriginCandidateV1 {
    return {
        materialization: {
            serverIdentityId: 'srv_specimen', machineId, materializationId: 'github', pluginId: 'happier.github', version,
            sourceClass: 'registryPackage', portableRelease: true, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: 100,
        },
        releaseContent: 'matched',
        validation,
    };
}

const CANDIDATES: readonly PluginMachineExecutionOriginCandidateV1[] = [
    candidate('studio-mac', '2.4.1', { kind: 'admitted' }),
    candidate('build-box', '2.4.1', { kind: 'rejected', reason: 'untrusted' }),
    candidate('old-laptop', '2.1.0', { kind: 'rejected', reason: 'daemon_unsupported' }),
    candidate('home-server', '2.4.1', { kind: 'rejected', reason: 'offline' }),
];

/** Also the editor's breakpoint-retention test model: one Event, its watchers and a filterable payload. */
export const EVENT_WATCHERS_SPECIMEN_MODEL: PluginEventAutomationComposerModel = {
    eligibleEvents: [EVENT],
    eventCatalogStatus: 'ready',
    selectedEvent: EVENT,
    selectEvent: noop,
    getEventPresentation: (candidate: { event: { title: string; description: string | null } }) => ({ title: candidate.event.title, description: candidate.event.description }),
    getPluginPresentation: () => ({
        eventKey: 'happier.github:events/pull-request', displayName: 'GitHub', availability: 'available',
        installedPackage: null, expectedOccurrenceId: null, machineId: null, serverId: null,
        accountLifetime: null, isCurrent: () => true,
    }),
    sourceStatus: 'idle', sourceFailure: null, sourceDisplayLabel: null, sourceInstanceId: null,
    availableObservationTransports: ['checkpointedPull'], observationTransport: 'checkpointedPull',
    setObservationTransport: noop, webhookEndpoint: null, refreshWebhookEndpoint: null,
    webhookEndpointRefreshing: false, configureSource: noop,
    watcherCandidates: CANDIDATES,
    watcherFailures: CANDIDATES.flatMap(candidate => {
        const failure = readPluginEventAutomationWatcherFailure(candidate, EVENT);
        return failure ? [{ ...failure, origin: getPluginExecutionOriginCandidateOrigin(candidate) }] : [];
    }),
    selectedWatcherOrigin: null, selectWatcher: noop,
    payloadBrowser: { fields: [{ pointer: '/action', scalarKind: 'string', sampleValue: 'opened' }], samplePayload: { action: 'opened' } },
    filterClauses: [], addFilterClause: noop, removeFilterClause: noop, setFilterClauseField: noop,
    setFilterClauseOperator: noop, setFilterClauseValueText: noop, filterValid: true,
    maximumObservationAgeMsText: '', setMaximumObservationAgeMsText: noop, maximumObservationAgeMsValid: true,
    createDraft: null, invalidateConfiguredSource: noop, revision: 0,
};

/**
 * Dev-only: the real Event Automation editor with watchers that cannot observe the selected Event,
 * a state a healthy fleet does not hold still. Never linked from product surfaces.
 */
export function EventWatchersSpecimen() {
    return (
        <View style={styles.page} testID="event-watchers-specimen">
            <View style={styles.popover}>
                <InlinePluginEventEditor model={EVENT_WATCHERS_SPECIMEN_MODEL} onComplete={noop} onCancel={noop} maxHeight={720} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base, alignItems: 'center', padding: theme.space.s16 },
    popover: { width: '100%', maxWidth: 440 },
}));
