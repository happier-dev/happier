import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';

type State = { basis: string; entityId: string; dirty: boolean; observations: PluginEventObservationV1[] | null };
/** Finite reads of retained owner facts. The shared SDK runner owns admission,
 * source lifecycle and replay; a committed row hint selects only its consumer. */
export function createRetainedFactEventSource<Source extends ProtocolJsonValue>(params: {
    host: BackgroundServiceContext['services']['events']['host']; eventId: string; schema: ProtocolComposableSchema<Source>;
    entityId(source: Source): string;
    read(context: BackgroundServiceContext, source: Source): Promise<Readonly<{
        occurrenceId: string; occurredAt: number; payload: ProtocolJsonValue;
    }> | null>;
    now: () => number;
}): PluginCheckpointedEventSourceAdapterV1<Source, State> {
    const states = new Map<string, State>();
    return {
        decode(definition) {
            if (definition.eventRef.localId !== params.eventId) return null;
            const parsed = params.schema.safeParse(definition.sourceConfig);
            return parsed.success ? parsed.data : null;
        },
        async observe({ context, definition, source }) {
            const basis = createCanonicalJsonSigningInput(source);
            let state = states.get(definition.sourceInstanceId);
            if (!state || state.basis !== basis) {
                state = { basis, entityId: params.entityId(source), dirty: true, observations: null };
                states.set(definition.sourceInstanceId, state);
            }
            if (state.observations === null) {
                state.observations = [];
                if (state.dirty) {
                    state.dirty = false;
                    try {
                        const fact = await params.read(context, source);
                        if (fact) state.observations.push({ ...fact, eventRef: definition.eventRef,
                            sourceInstanceId: definition.sourceInstanceId, sourceContractVersion: definition.sourceContractVersion,
                            observationReceivedAt: params.now(), observedDelta: 1 });
                    } catch (error) { state.dirty = true; state.observations = null; throw error; }
                }
            }
            return { observations: state.observations, checkpoint: state, complete: true,
                nextEligibleAt: state.dirty ? params.now() : null };
        },
        async save({ checkpoint }) { checkpoint.observations = null; },
        retryAt() { return null; },
        async retire({ definitions }) {
            const current = new Set(definitions.map(definition => definition.sourceInstanceId));
            for (const id of states.keys()) if (!current.has(id)) states.delete(id);
            return { complete: true };
        },
        subscribeWake(wake) {
            const rows = params.host.subscribe({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' } }, async event => {
                const changed = new Set(event.payload.entityIds);
                for (const [id, state] of states) if (changed.has(state.entityId)) { state.dirty = true; await wake(id); }
            });
            const reconnect = params.host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
                if (event.payload.reason !== 'reconnect') return;
                for (const state of states.values()) state.dirty = true;
                await wake();
            });
            return { dispose() { rows.dispose(); reconnect.dispose(); } };
        },
    };
}
