import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import {
    admitCheckpointedPluginEventObservationV1,
    createPluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    type PluginEventAutomationHistoryGapResetActionResultV1,
    type PluginEventAutomationSetupResultV1,
} from '@happier-dev/plugin-sdk/events';

const PLUGIN_ID = 'com.example.automation-event-observer';
const LEDGER_EVENT_ID = 'ledger-entry-appended';
const LEDGER_SETUP_ACTION_ID = 'setup-ledger-source';
const LEDGER_HISTORY_GAP_RESET_ACTION_ID = 'reset-ledger-baseline';
const LEDGER_SOURCE_CONTRACT_VERSION = 1;

/**
 * The private source facts this external plugin persists through the canonical
 * Automation writer. Nothing here is host vocabulary: the ledger identity is
 * this fixture's own domain, exactly as a third-party source's would be.
 */
const LEDGER_SOURCE_CONFIG_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        v: { type: 'integer', const: 1 },
        ledgerId: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['v', 'ledgerId'],
} satisfies PluginJsonSchema;

/**
 * The canonical setup-result shape the host manifest owner requires for this
 * exact source contract version and source-config schema.
 */
const LEDGER_SETUP_RESULT_SCHEMA = createPluginEventAutomationSetupResultV1JsonSchema(
    LEDGER_SOURCE_CONTRACT_VERSION,
    LEDGER_SOURCE_CONFIG_SCHEMA,
);

const LEDGER_EVENT_PAYLOAD_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        entryId: { type: 'string', minLength: 1, maxLength: 256 },
        summary: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['entryId', 'summary'],
} satisfies PluginJsonSchema;

/** Deterministic stand-in for the external system this source observes. */
export type LedgerEntryV1 = Readonly<{
    entryId: string;
    occurredAt: number;
    summary: string;
}>;

export const LEDGER_ENTRIES: readonly LedgerEntryV1[] = Object.freeze([
    Object.freeze({ entryId: 'entry-1', occurredAt: 1_725_000_000_000, summary: 'ledger opened' }),
]);

/**
 * The external source's observation cycle. It reaches the host only through
 * the public checkpointed-Event helper, exactly like first-party sources: the
 * helper owns the complete current source scan plus canonical admission/status
 * Actions, while the host owns the adopted definition set, occurrence identity,
 * and Run.
 */
export async function runLedgerSourceObserver(context: BackgroundServiceContext): Promise<void> {
    for (const entry of LEDGER_ENTRIES) {
        context.signal.throwIfAborted();
        const disposition = await admitCheckpointedPluginEventObservationV1({
            eventRef: { pluginId: PLUGIN_ID, localId: LEDGER_EVENT_ID },
            sourceInstanceId: 'ledger:main',
            sourceContractVersion: LEDGER_SOURCE_CONTRACT_VERSION,
            occurrenceId: entry.entryId,
            occurredAt: entry.occurredAt,
            observationReceivedAt: entry.occurredAt + 1,
            observedDelta: 1,
            payload: { entryId: entry.entryId, summary: entry.summary },
        }, context);
        context.services.logger.info('automation_event_source.settled', {
            occurrenceId: entry.entryId,
            disposition,
        });
        if (disposition.kind !== 'checkpointSafe') return;
    }
}

export const { manifest, activate } = definePlugin({
    id: PLUGIN_ID,
    version: '1.0.0',
    displayName: 'Automation event observer fixture',
    engines: { happier: '>=0.0.0 <1.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/index.js' },
    actions: {
        [LEDGER_SETUP_ACTION_ID]: {
            title: 'Set up ledger Event source',
            description: 'Resolves a ledger to immutable source facts for an Automation Event.',
            scopes: ['global'],
            surfaces: ['plugin'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { ledgerId: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['ledgerId'],
            },
            resultSchema: LEDGER_SETUP_RESULT_SCHEMA,
            run: (input): PluginEventAutomationSetupResultV1 => {
                const ledgerId = (input as Readonly<{ ledgerId: string }>).ledgerId;
                return {
                    v: 1,
                    sourceInstanceId: `ledger:${ledgerId}`,
                    sourceContractVersion: LEDGER_SOURCE_CONTRACT_VERSION,
                    sourceConfig: { v: 1, ledgerId },
                    displayLabel: `Ledger ${ledgerId}`,
                };
            },
        },
        [LEDGER_HISTORY_GAP_RESET_ACTION_ID]: {
            title: 'Start a new ledger baseline',
            description: 'Replaces a ledger history gap with a current baseline. Entries in the gap are not replayed.',
            scopes: ['global'],
            surfaces: ['plugin'],
            dangerLevel: 'writesLocal',
            execution: { target: 'daemon' },
            inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
            resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
            run: (): PluginEventAutomationHistoryGapResetActionResultV1 => {
                // The host fills this Action's input from the stored binding. This
                // ledger keeps no per-binding checkpoint, so every gap it is asked
                // about can be baselined. A source that stores checkpoints answers
                // `stale` when the requested binding no longer resolves to a current
                // source, and `noHistoryGap` when it recorded no gap at all.
                return { kind: 'baselined' };
            },
        },
    },
    events: {
        [LEDGER_EVENT_ID]: {
            declaration: {
                kind: 'event',
                title: 'Ledger entry appended',
                description: 'A ledger entry observed through checkpointed polling.',
                payloadSchema: LEDGER_EVENT_PAYLOAD_SCHEMA,
                automation: {
                    v: 1,
                    eligible: true,
                    source: {
                        sourceContractVersion: LEDGER_SOURCE_CONTRACT_VERSION,
                        supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema: LEDGER_SOURCE_CONFIG_SCHEMA,
                        setupActionRef: { pluginId: PLUGIN_ID, localId: LEDGER_SETUP_ACTION_ID },
                        historyGapResetActionRef: {
                            pluginId: PLUGIN_ID,
                            localId: LEDGER_HISTORY_GAP_RESET_ACTION_ID,
                        },
                    },
                },
            },
        },
        'observe-run-state-changed': {
            declaration: {
                kind: 'subscription',
                target: {
                    kind: 'host',
                    eventId: '@happier/automation/run-state-changed',
                    scope: { kind: 'account' },
                },
            },
            handler: async (payload, context) => {
                context.services.logger.info('automation_event_observer.received', {
                    transition: payload,
                });
            },
        },
    },
    backgroundServices: [{
        declaration: {
            id: 'ledger-source-observer',
            title: 'Ledger Event source observer',
        },
        runner: runLedgerSourceObserver,
    }],
});
