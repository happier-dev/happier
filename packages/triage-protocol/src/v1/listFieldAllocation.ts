import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolJsonValue, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { createTriageListSourceSchemasV1 } from './listSourceSchemas.js';
import { createTriageListResultSchemasV1 } from './listResultSchemas.js';
import { buildMaximalSchemaValue } from './maximumEncodedValue.js';
import { ENTRY_REF } from './entryReferenceSeed.js';
import { MAX_TRIAGE_LIST_SOURCE_BATCH_V1 } from './constants.js';

function withTaskFactsWitness(fragment: PluginJsonSchema): PluginJsonSchema {
    return {
        ...fragment,
        ...(fragment.anyOf === undefined ? {} : { anyOf: fragment.anyOf.map(withTaskFactsWitness) }),
        ...(fragment.items === undefined ? {} : { items: withTaskFactsWitness(fragment.items) }),
        ...(fragment.properties === undefined ? {} : { properties: Object.fromEntries(
            // Optional label collections carry provider-sized names. Exclude
            // them from this finite sub-envelope rather than invent maxima.
            Object.entries(fragment.properties)
                .filter(([key]) => key !== 'labels' && key !== 'labelColors')
                .map(([key, child]): [string, PluginJsonSchema] => [key,
                ['configuredSources', 'lanes', 'continuations'].includes(key) && child.type === 'array'
                    ? { ...withTaskFactsWitness(child), maxItems: MAX_TRIAGE_LIST_SOURCE_BATCH_V1 }
                    : key === 'scope' ? { const: {
                    unit: { singularLabel: 'Project', pluralLabel: 'projects' },
                    projection: { kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['project-1'] },
                        units: [{ id: 'project-1', label: 'Platform' }] },
                } } : key === 'relations' ? { const: {
                    parent: ENTRY_REF, children: { total: 1, completed: 0, entries: [ENTRY_REF], complete: true },
                    blockedBy: [ENTRY_REF],
                } } : key === 'taskCapabilities' ? { const: {
                    editFields: ['title'], transitions: [{ id: 'start', label: 'Start', state: { presentation: 'active', stage: 'started' } }],
                } } : key === 'facts' && child.type === 'array'
                    ? { ...withTaskFactsWitness(child), maxItems: 4 }
                    : withTaskFactsWitness(child),
            ]),
        ) }),
    };
}

function measureFiniteListAllocation(fieldBytes: number): number {
    const { TriageListEntriesResultV1Schema } = createTriageListResultSchemasV1(
        fieldBytes,
        createTriageListSourceSchemasV1(fieldBytes),
        // These two provider-owned adjuncts are replaced/omitted by the finite
        // allocation below. They retain their real schemas at the aggregate.
        defineProtocolJsonValue(),
        defineProtocolJsonValue(),
    );
    const shape = withTaskFactsWitness(TriageListEntriesResultV1Schema.jsonSchema);
    const window = shape.properties?.window?.properties;
    const row = window?.rows?.items?.properties;
    if (window === undefined || row?.otherObservations === undefined || row.observedByCount === undefined) {
        throw new Error('The Triage list allocation requires its row and window geometry');
    }
    delete window.taskProjection;
    // One rendered observation per row is this finite core allocation. Extra
    // provider observations remain under the host's actual response envelope.
    row.otherObservations.maxItems = 0;
    row.observedByCount.maximum = 1;
    const value = buildMaximalSchemaValue(shape, 'triageListAllocation');
    // Retain the walk's additive-object probe in the conservative measurement,
    // exactly as the independent aggregate regression does. That regression
    // also parses the maximal result through the real aggregate schema; this
    // internally constructed allocation needs no second full-page validation.
    return measureExternalActionResultResponseEnvelopeUtf8BytesV1(value);
}

/** Derived from actual shared schemas, never a ledger of fields or framing. */
export function deriveTriageListFieldUtf8BytesV1(): number {
    // At this size string-bearing union arms dominate fixed numeric siblings;
    // adjacent samples reveal the actual escaped-byte slope and fixed framing.
    const sample = 1024;
    const bytes = measureFiniteListAllocation(sample);
    const units = measureFiniteListAllocation(sample + 1) - bytes;
    const fixedBytes = bytes - units * sample;
    return Math.floor((EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes) / units);
}
