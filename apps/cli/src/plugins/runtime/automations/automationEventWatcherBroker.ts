import type { PluginInvocationCaller } from '@happier-dev/plugin-sdk';
import type { PluginMachineMaterializationRefV1, QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol';
import { AutomationEventAdmitDefinitionSelectorV1Schema, type AutomationEventAdmitDefinitionSelectorV1,
    type AutomationEventSourceDefinitionV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { ConnectedAccountActionFormTeamSelectionV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { GITHUB_BROKER_WATCHER_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { z } from 'zod/mini';

import {
    createTeamCredentialWatcherRead, type TeamCredentialWatcherTransport,
} from '@/providers/broker/teamCredentialWatcherClient';
import { logger } from '@/ui/logger';
import type { PluginHttpRuntimeAdapter } from '../fetch/service';
import { admissionKey, type AutomationEventAdoptedDefinitionSetV1 } from './automationEventAdoptedDefinitionSet';

type WatcherKind = 'checkpointedPull' | 'durablePush';
type WatcherRead = ReturnType<typeof createTeamCredentialWatcherRead>;
export type AutomationEventWatcherBindingInput = Readonly<{
    caller?: PluginInvocationCaller;
    selected: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
    input: unknown;
}>;

const watcherSourceConfigSchema = z.looseObject({
    credentialRef: ConnectedAccountActionFormTeamSelectionV1Schema,
    repository: z.looseObject({ owner: z.string(), name: z.string(), repositoryId: z.string() }),
    checks: z.optional(z.looseObject({ pullRequestNumber: z.number() })),
});
const sourceAttemptSchema = z.looseObject({ definitions: z.array(z.object({
    ...AutomationEventAdmitDefinitionSelectorV1Schema.shape,
    observationTransport: z.object({ kind: z.enum(['checkpointedPull', 'durablePush']) }),
})).check(z.minLength(1)) });

function watcherSourceKey(definition: AutomationEventSourceDefinitionV1, materialization: PluginMachineMaterializationRefV1) {
    return createCanonicalJsonSigningInput({
        pluginId: definition.eventRef.pluginId, sourceInstanceId: definition.sourceInstanceId,
        sourceContractVersion: definition.sourceContractVersion, sourceConfig: definition.sourceConfig, materialization,
    });
}

/** Retains only currently adopted GitHub source bindings, at the Event occurrence owner. */
export function createAutomationEventWatcherBroker(transport: TeamCredentialWatcherTransport) {
    type SourceEntry = { kind: WatcherKind; activation: AutomationEventAdmitDefinitionSelectorV1; read: WatcherRead };
    type Occurrence = Readonly<{
        sources: Map<string, SourceEntry>;
        materialization: PluginMachineMaterializationRefV1;
        resolveAdopted(kind: WatcherKind): AutomationEventAdoptedDefinitionSetV1 | null;
    }>;
    const occurrences = new Map<string, Occurrence>();

    function retire(source: SourceEntry): void {
        void source.read.dispose().catch(() => logger.debug('Could not close the Automation Event watcher HTTP transport'));
    }

    function resetOccurrence(occurrence: Occurrence): void {
        for (const source of occurrence.sources.values()) retire(source);
        occurrence.sources.clear();
    }

    return Object.freeze({
        bind(request: AutomationEventWatcherBindingInput, occurrenceSignal: AbortSignal, resolveAdopted: Occurrence['resolveAdopted']): PluginHttpRuntimeAdapter | null {
            const { caller, selected } = request;
            const { service, backgroundServiceId } = GITHUB_BROKER_WATCHER_V1;
            if (occurrenceSignal.aborted || caller?.kind !== 'plugin' || caller.pluginId !== service.pluginId
                || caller.contribution.id !== backgroundServiceId || caller.originSurface !== 'background'
                || !caller.materialization || selected.selection.deliveryMode !== 'brokered') return null;
            const materialization = caller.materialization;
            const attempt = sourceAttemptSchema.safeParse(request.input);
            if (!attempt.success) return null;
            const selectors = attempt.data.definitions;
            const { observationTransport, ...activation } = selectors[0]!;
            const kind = observationTransport.kind;
            const owner = resolveAdopted(kind);
            const projection = owner?.readPublicProjection({ definitions: selectors });
            if (projection?.kind !== 'available' || projection.definitions.length !== selectors.length) return null;
            const first = projection.definitions[0]!;
            const key = watcherSourceKey(first, materialization);
            if (!projection.definitions.every(definition => {
                const observation = definition.observationTransport;
                const assigned = observation.kind === 'checkpointedPull' ? observation.watcherMaterializationRef
                    : observation.kind === 'durablePush' ? observation.endpointMaterializationRef : null;
                return observation.kind === kind && assigned !== null
                    && arePluginMachineMaterializationRefsEqual(assigned, materialization)
                    && watcherSourceKey(definition, materialization) === key;
            })) return null;
            const config = watcherSourceConfigSchema.safeParse(first.sourceConfig);
            if (!config.success || config.data.credentialRef.teamId !== selected.teamId
                || !sameStrictJsonValue(config.data.credentialRef.selection, selected.selection)) return null;

            let occurrence = occurrences.get(caller.occurrenceId);
            if (!occurrence) {
                const current: Occurrence = { sources: new Map(), materialization, resolveAdopted };
                occurrences.set(caller.occurrenceId, current);
                occurrenceSignal.addEventListener('abort', () => {
                    occurrences.delete(caller.occurrenceId);
                    resetOccurrence(current);
                }, { once: true });
                occurrence = current;
            }
            const existing = occurrence.sources.get(key);
            if (existing) {
                const activeKey = admissionKey(existing.activation);
                if (selectors.some(selector => admissionKey(selector) === activeKey)) return existing.read.adapter;
                retire(existing);
            }
            const read = createTeamCredentialWatcherRead({
                ...transport,
                caller: { pluginId: caller.pluginId, contributionLocalId: caller.contribution.id,
                    occurrenceId: caller.occurrenceId, materialization, sourceCustody: caller.sourceCustody },
                activation,
                teamId: selected.teamId, resourceId: selected.selection.resourceId, purpose: selected.purpose,
                repository: config.data.repository,
                ...(config.data.checks ? { checks: { eventLocalId: first.eventRef.localId,
                    pullRequestNumber: config.data.checks.pullRequestNumber } } : {}),
            });
            occurrence.sources.set(key, { kind, activation, read });
            return read.adapter;
        },
        resetOnReconnect() {
            for (const occurrence of occurrences.values()) resetOccurrence(occurrence);
        },
        reconcileAdopted() {
            for (const occurrence of occurrences.values()) {
                for (const [key, source] of occurrence.sources) {
                    const projection = occurrence.resolveAdopted(source.kind)?.readPublicProjection({ definitions: [source.activation] });
                    if (projection?.kind !== 'available' || projection.definitions.some(definition => (
                        watcherSourceKey(definition, occurrence.materialization) === key
                    ))) continue;
                    occurrence.sources.delete(key);
                    retire(source);
                }
            }
        },
    });
}
