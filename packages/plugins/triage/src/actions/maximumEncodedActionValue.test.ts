import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } from '@happier-dev/plugin-sdk';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    buildMaximalSchemaValue,
    encodedJsonBytes,
    createTriageSourceV1Fixture,
    type MeasurableSchemaV1,
} from '@happier-dev/triage-protocol/testing/v1';

import {
    MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
    MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
    TriagePullRequestStatusResultV1Schema,
    TriageEntryRefV1Schema,
    TriageEntryLocatorV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
    TriageTaskWriteResultV1Schema,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { TriageCreateTaskActionInputV1Schema, TriageEditTaskActionInputV1Schema, TriageTransitionTaskActionInputV1Schema, TriageTaskDraftV1Schema } from './tasksProtocol.js';
import {
    TriageMountedSourceInsertInputV1Schema,
    TriageMountedSourceRevealInputV1Schema,
    TriageMountedUiInputV1Schema,
    TriageMountedUiResultV1Schema,
} from './mountedUiProtocol.js';
import { TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from './configuredActionRunProtocol.js';
import {
    TriageAdministerActionInputV1Schema,
    TriageAdministerActionResultV1Schema,
    TriageReadActionsInputV1Schema,
    TriageReadActionsResultV1Schema,
} from './actionsCatalogProtocol.js';
import { MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 } from '../settings/actions.js';
import { MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 } from '../settings/savedViews.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import {
    TriageReadEntryDetailInputV1Schema,
    TriageReadEntryDetailResultV1Schema,
} from './entryDetailProtocol.js';
import {
    TriageReobserveEntryInputV1Schema,
    TriageReobserveEntryResultV1Schema,
} from './reobserveEntryProtocol.js';
import {
    TriageStartEntrySessionInputV1Schema,
    TriageStartEntrySessionResultV1Schema,
    TriageStartPullRequestReviewInputV1Schema,
    TriageStartPullRequestReviewResultV1Schema,
    TriageUnlinkEntryFromSessionActionInputV1Schema,
    TriageUnlinkEntryFromSessionActionResultV1Schema,
} from './entrySessionProtocol.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    triageListRowBudgetV1,
    TriageListEntriesInputV1Schema,
    TriageListEntriesResultV1Schema,
} from './listEntriesProtocol.js';
import {
    TriageAdministerSavedViewInputV1Schema,
    TriageAdministerSavedViewResultV1Schema,
    TriageReadSavedViewsInputV1Schema,
    TriageReadSavedViewsResultV1Schema,
} from './savedViewsProtocol.js';
import {
    TriageLinkEntryToSessionActionResultV1Schema,
    TriageLinkEntryToSessionInputV1Schema,
    TriageReadSourceSessionLinksInputV1Schema,
    TriageReadSourceSessionLinksResultV1Schema,
} from './sessionLinksProtocol.js';
import {
    TriageListPinnedEntriesInputV1Schema,
    TriageListPinnedEntriesResultV1Schema,
    TriageSetEntryPinnedInputV1Schema,
    TriageSetEntryPinnedResultV1Schema,
} from './userMarksProtocol.js';
import {
    TriageReadFixPullRequestsInputV1Schema,
    TriageReadFixPullRequestsResultV1Schema,
    TriageSetFixPullRequestInputV1Schema,
    TriageSetFixPullRequestResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * Serialized-size regression coverage for this aggregate's Action values.
 *
 * `packages/triage-protocol/src/v1/maximumEncodedResult.test.ts` proves the
 * *source-facing* operation values fit their schemas. Nothing proved that this
 * target's own Action values retain their measured size. Every plugin Action
 * input and result is parsed by `AgentRuntimeJsonValueV1Schema`
 * (`packages/protocol/src/runtime/agentSessionV1.ts`) at
 * `packages/protocol/src/plugins/actions/invocation.ts` **before** the manifest
 * `resultSchema` is checked. That schema establishes strict JSON safety only;
 * it does not own an aggregate byte limit for Action values.
 *
 * The values measured here are real schema-derived values, not copies of a
 * transport or persistence limit. A future aggregate boundary must be owned
 * and tested at that named boundary rather than inferred from this parser.
 *
 * Finite maxima come from the public source-protocol derivation. Provider-sized
 * task facts use explicit finite witnesses and the real host envelope check;
 * those witnesses do not establish a maximum for an unbounded result.
 */

/**
 * Values whose schema has a finite structural maximum.
 */
const structurallyBoundedSchemas = {
    mountedUiResult: TriageMountedUiResultV1Schema,
    readEntryDetailInput: TriageReadEntryDetailInputV1Schema,
    reobserveEntryInput: TriageReobserveEntryInputV1Schema,
    setEntryPinnedResult: TriageSetEntryPinnedResultV1Schema,
    listPinnedEntriesInput: TriageListPinnedEntriesInputV1Schema,
    readFixPullRequestsInput: TriageReadFixPullRequestsInputV1Schema,
    setFixPullRequestResult: TriageSetFixPullRequestResultV1Schema,
    linkEntryToSessionResult: TriageLinkEntryToSessionActionResultV1Schema,
    unlinkEntryFromSessionInput: TriageUnlinkEntryFromSessionActionInputV1Schema,
    unlinkEntryFromSessionResult: TriageUnlinkEntryFromSessionActionResultV1Schema,
    readSavedViewsInput: TriageReadSavedViewsInputV1Schema,
    readActionsInput: TriageReadActionsInputV1Schema,
    // The two caller-bound source Actions are declared by this manifest, so
    // this plugin's own gate proof covers them too. `@happier-dev/triage-protocol`
    // derives them independently as the owner of their shapes; two pins over one
    // derivation is a second measurement, not a second bounds ledger, and it is
    // what lets the assertion below be "every declared schema" with no
    // exclusions to keep true.
    administerSourceInstanceInput: TriageSourceAdministrationActionInputV1Schema,
    administerSourceInstanceResult: TriageSourceAdministrationActionResultV1Schema,
    readConfiguredInstancesInput: TriageReadConfiguredSourceInstancesInputV1Schema,
    readSourceSessionLinksInput: TriageReadSourceSessionLinksInputV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * The saved-view results, whose reachable maximum is smaller than their
 * structural one and is owned elsewhere.
 *
 * Both carry the stored `triage.savedViews` set, and `savedViews.ts` bounds
 * that whole serialized value at `MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1`
 * — a bound over the complete value, which no per-member schema can express.
 * The writer refuses a mutation past it and the reader refuses a stored value
 * past it, so the widest set either Action can return is that ceiling plus this
 * result's own small framing. Measuring them against the schema instead would
 * mean shrinking a product bound to satisfy a value the owner already makes
 * unreachable.
 */
const ownerBoundedSchemas = {
    readActionsResult: TriageReadActionsResultV1Schema,
    administerActionResult: TriageAdministerActionResultV1Schema,
    readSavedViewsResult: TriageReadSavedViewsResultV1Schema,
    administerSavedViewResult: TriageAdministerSavedViewResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * Values with a deliberately unbounded member. They remain strict JSON, but a
 * maximum encoded value cannot be derived without inventing a product quota.
 */
const structurallyUnboundedSchemas = {
    // Durable display values use the measured Collection envelope, not a field quota.
    setEntryPinnedInput: TriageSetEntryPinnedInputV1Schema,
    listPinnedEntriesResult: TriageListPinnedEntriesResultV1Schema,
    setFixPullRequestInput: TriageSetFixPullRequestInputV1Schema,
    // Linked Sessions follow the real relationship set, not a local count quota.
    readEntryDetailResult: TriageReadEntryDetailResultV1Schema,
    taskDraftInput: TriageTaskDraftV1Schema,
    readSourceSessionLinksResult: TriageReadSourceSessionLinksResultV1Schema,
    // Live task relations/native transitions and write fields follow provider
    // data. The host envelope, rather than a per-task membership cap, owns size.
    listEntriesResult: TriageListEntriesResultV1Schema,
    reobserveEntryResult: TriageReobserveEntryResultV1Schema,
    createTaskInput: TriageCreateTaskActionInputV1Schema,
    editTaskInput: TriageEditTaskActionInputV1Schema,
    taskWriteResult: TriageTaskWriteResultV1Schema,
    transitionTaskInput: TriageTransitionTaskActionInputV1Schema,
    linkEntryToSessionInput: TriageLinkEntryToSessionInputV1Schema,
    // Universal Search owns unbounded query text and result items; no local quota.
    searchEntriesInput: PluginSearchQueryV1Schema,
    searchEntriesResult: PluginSearchResultV1Schema,
    // The fix-PR candidate projection follows real linked Sessions without a count quota.
    readFixPullRequestsResult: TriageReadFixPullRequestsResultV1Schema,
    runConfiguredActionInput: TriageRunConfiguredActionInputV1Schema,
    runConfiguredActionResult: TriageRunConfiguredActionResultV1Schema,
    // The mounted owner admits exact selections without a product count quota.
    mountedUiInput: TriageMountedUiInputV1Schema,
    // Mounted source operations retain exact, unbounded owner occurrence identities.
    mountedSourceRevealInput: TriageMountedSourceRevealInputV1Schema,
    mountedSourceInsertInput: TriageMountedSourceInsertInputV1Schema,
    // PR status walks source-owned rows without a product count ceiling.
    readPullRequestStatusResult: TriagePullRequestStatusResultV1Schema,
    startEntrySessionInput: TriageStartEntrySessionInputV1Schema,
    startEntrySessionResult: TriageStartEntrySessionResultV1Schema,
    // The review request deliberately carries an unbounded engine selection
    // and provider-owned pull-request JSON. Its result reports what became of
    // each engine in that same selection — every requested id appears exactly
    // once, across the started and failed halves — so it inherits precisely
    // that one unbounded dimension and no other. Bounding it would mean
    // inventing an engine-count quota no owner establishes.
    startPullRequestReviewInput: TriageStartPullRequestReviewInputV1Schema,
    startPullRequestReviewResult: TriageStartPullRequestReviewResultV1Schema,
    listEntriesInput: TriageListEntriesInputV1Schema,
    administerSavedViewInput: TriageAdministerSavedViewInputV1Schema,
    administerActionInput: TriageAdministerActionInputV1Schema,
    // The durable configured-source set has no product count ceiling. Its
    // reader fits whole records against the canonical Action envelope and uses
    // the published `truncated` status when the tail cannot cross it.
    readConfiguredInstancesResult: TriageReadConfiguredSourceInstancesResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * A finite witness for task and configured-unit facts, used only to keep the existing independent
 * row/frontier presentation and control regression. Optional provider-sized
 * label collections and the native task projection are excluded. The remaining
 * example relationships/transitions are not product bounds or a maximum of the
 * actual provider-sized list result; its transport envelope owns that boundary.
 */
const taskFactsEntryRef = createTriageSourceV1Fixture().detailInput.observation.entryRef;
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
                .map(([key, child]) => [key,
                key === 'scope' ? { const: {
                    unit: { singularLabel: 'Project', pluralLabel: 'projects' },
                    projection: { kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['project-1'] },
                        units: [{ id: 'project-1', label: 'Platform' }] },
                } } : key === 'relations' ? { const: {
                    parent: taskFactsEntryRef, children: { total: 1, completed: 0, entries: [taskFactsEntryRef], complete: true },
                    blockedBy: [taskFactsEntryRef],
                } } : key === 'taskCapabilities' ? { const: {
                    editFields: ['title'], transitions: [{ id: 'start', label: 'Start', state: { presentation: 'active', stage: 'started' } }],
                } } : key === 'facts' && child.type === 'array'
                    ? { ...withTaskFactsWitness(child), maxItems: 4 }
                    : withTaskFactsWitness(child),
            ]),
        ) }),
    };
}
function listEntriesResultWitnessAt(rows: number, frontiers: number): PluginJsonSchema {
    const result = withTaskFactsWitness(TriageListEntriesResultV1Schema.jsonSchema);
    const windowProperties = { ...result.properties?.window?.properties };
    // Native order/Session relationships are provider-sized adjuncts. This
    // independent finite row/frontier allocation does not bound them; the
    // composed 60-Task page test checks its real projection at the host envelope.
    delete windowProperties.taskProjection;
    if (windowProperties.continuations === undefined || windowProperties.rows === undefined) {
        throw new Error('the list window no longer carries both a row array and a continuation set');
    }
    windowProperties.rows = { ...windowProperties.rows, maxItems: rows };
    if (frontiers === 0) {
        delete windowProperties.continuations;
    } else {
        windowProperties.continuations = { ...windowProperties.continuations, maxItems: frontiers };
    }
    return {
        ...result,
        properties: {
            ...result.properties,
            window: { ...result.properties?.window, properties: windowProperties },
        },
    };
}

/** Re-measure the same bounded allocation with provider collections held at their explicit witnesses. */
function withFieldAllocation(fragment: PluginJsonSchema, bytes: number): PluginJsonSchema {
    const fieldBounds = new Set([
        MAX_TRIAGE_TEXT_UTF8_BYTES_V1, MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
        MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
        MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
        MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    ]);
    const allocated = fragment.type === 'string'
        && fragment.pattern === TRIAGE_SINGLE_LINE_STRING_PATTERN_V1
        && fragment['x-happier-max-utf8-bytes'] !== undefined
        && fieldBounds.has(fragment['x-happier-max-utf8-bytes']);
    return {
        ...fragment,
        ...(allocated ? { 'x-happier-max-utf8-bytes': bytes } : {}),
        ...(fragment.anyOf === undefined ? {} : { anyOf: fragment.anyOf.map(child => withFieldAllocation(child, bytes)) }),
        ...(fragment.items === undefined ? {} : { items: withFieldAllocation(fragment.items, bytes) }),
        ...(fragment.properties === undefined ? {} : { properties: Object.fromEntries(
            Object.entries(fragment.properties).map(([key, child]) => [key, withFieldAllocation(child, bytes)]),
        ) }),
    };
}

function admits(value: unknown): boolean {
    return AgentRuntimeJsonValueV1Schema.safeParse(value).success;
}

describe('aggregate Action value shapes', () => {
    it('derives one presentation and control field allocation from a finite 56-row 32-lane witness', async () => {
        const shape = listEntriesResultWitnessAt(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
        const row = shape.properties?.window?.properties?.rows?.items?.properties;
        if (row?.otherObservations === undefined || row.observedByCount === undefined) throw new Error('missing observation geometry');
        row.otherObservations.maxItems = 0;
        row.observedByCount.maximum = 1;
        const measure = async (bytes: number, projection = shape) => {
            // Each maximal witness is real megabytes of JSON. Flush the test
            // worker's reporting channel between independent measurements.
            await setImmediate();
            return measureExternalActionResultResponseEnvelopeUtf8BytesV1(
                buildMaximalSchemaValue(withFieldAllocation(projection, bytes), 'fieldAllocation'),
            );
        };
        // Sample where string-bearing union arms dominate their fixed numeric
        // siblings; a one-byte string can select a different maximal arm.
        const sample = 1024;
        const sampledBytes = await measure(sample);
        const escapedFieldUnits = await measure(sample + 1) - sampledBytes;
        const fixedBytes = sampledBytes - escapedFieldUnits * sample;
        const derived = Math.floor((EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes) / escapedFieldUnits);
        // Adding a real projected text field reduces its envelope allocation,
        // while all four persisted instance fields keep their retained contract.
        const expanded = structuredClone(shape);
        expanded.properties!.window!.properties!.rows!.items!.properties!.extraDisplay =
            TriageEntryLocatorV1Schema.jsonSchema.properties!.displayPath!;
        const expandedBytes = await measure(sample, expanded);
        const expandedUnits = await measure(sample + 1, expanded) - expandedBytes;
        const expandedFixed = expandedBytes - expandedUnits * sample;
        expect(Math.floor((EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - expandedFixed) / expandedUnits)).toBeLessThan(derived);
        const instance = TriageConfiguredSourceInstanceV1Schema.jsonSchema.properties!;
        for (const field of [instance.configuration!.properties!.token!,
            instance.locator!.properties!.displayLabel!, instance.locator!.properties!.displayPath!, instance.locator!.properties!.webUrl!]) {
            expect(field['x-happier-max-utf8-bytes']).toBe(7_336);
        }
        expect([
            MAX_TRIAGE_TEXT_UTF8_BYTES_V1, MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
            MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
            MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
            MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
        ], `fixedBytes=${fixedBytes}, escapedFieldUnits=${escapedFieldUnits}, derived=${derived}`)
            .toEqual(Array.from({ length: 6 }, () => derived));
        // Share this finite witness with the continuation proof rather
        // than rebuilding the same 24 MB shape in two overlapping tests.
        await setImmediate();
        const maximal = buildMaximalSchemaValue(shape, 'listEntriesResult');
        await setImmediate();
        const parsed = TriageListEntriesResultV1Schema.parse(maximal);
        expect(parsed.configuredSources[0]?.scope?.projection).toMatchObject({ kind: 'page',
            selection: { kind: 'selected', unitIds: ['project-1'] } });
        expect(parsed.window.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(parsed.window.rows.reduce((total, item) => total + 1 + item.otherObservations.length, 0))
            .toBe(triageListRowBudgetV1(MAX_TRIAGE_LIST_SOURCE_BATCH_V1));
        await setImmediate();
        const maximalBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(maximal);
        expect(maximalBytes).toBe(fixedBytes + escapedFieldUnits * derived);
        expect(maximalBytes).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(fixedBytes + escapedFieldUnits * (derived + 1))
            .toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);

        const token = shape.properties?.window?.properties?.continuations
            ?.items?.properties?.continuation?.properties?.token;
        if (token?.['x-happier-max-utf8-bytes'] !== MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1) {
            throw new Error('the list continuation token no longer carries the shared byte ceiling');
        }
        const tokenAt = (bytes: number): string => {
            const value = buildMaximalSchemaValue({ ...token, 'x-happier-max-utf8-bytes': bytes }, 'continuationToken');
            if (typeof value !== 'string') throw new Error('a continuation token must be a string');
            return value;
        };
        const laneTokenCount = parsed.window.continuations.length;
        expect(laneTokenCount).toBe(MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
        const encodedBytesPerTokenByte = encodedJsonBytes(tokenAt(derived + 1))
            - encodedJsonBytes(tokenAt(derived));
        expect(encodedBytesPerTokenByte).toBeGreaterThan(0);
        const firstRejectedTokenUtf8Bytes = derived
            + Math.floor((EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - maximalBytes)
                / (laneTokenCount * encodedBytesPerTokenByte)) + 1;
        const widenedToken = tokenAt(firstRejectedTokenUtf8Bytes);
        if (maximal === null || typeof maximal !== 'object' || !('window' in maximal)
            || maximal.window === null || typeof maximal.window !== 'object') {
            throw new Error('the maximal list witness must carry a window');
        }
        // Preserve the measured schema witness, including additive-read probe
        // fields the successful typed reader may legitimately discard.
        const oversized = { ...maximal, window: { ...maximal.window,
            continuations: parsed.window.continuations.map(lane => {
                if (lane.continuation === undefined) throw new Error('the maximal witness lost a lane frontier');
                return { ...lane, continuation: { ...lane.continuation, token: widenedToken } };
            }),
        } };
        await setImmediate();
        const oversizedBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(oversized);
        expect(oversizedBytes).toBe(maximalBytes
            + (firstRejectedTokenUtf8Bytes - derived) * laneTokenCount * encodedBytesPerTokenByte);
        expect(oversizedBytes - laneTokenCount * encodedBytesPerTokenByte)
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(oversizedBytes).toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(oversized)).toBe(false);
    }, 120_000);

    /**
     * The measured set has to be the declared set, or an Action added later
     * simply would not be measured. There are no exclusions: an Action this
     * manifest declares crosses this gate whoever owns its shape.
     */
    it('validates every finite declared Action maximum through its real schema and the host JSON gate', () => {
        // The manifest supplies new Actions automatically; the explicitly
        // classified schemas retain the source-role and owner-bound checks.
        const schemas = new Map<string, Readonly<{ label: string; schema: PluginJsonSchema; parse?: (value: unknown) => unknown }>>([
            ...PLUGIN_MANIFEST.contributes.actions.flatMap(action =>
                ([['input', action.inputSchema], ['result', action.resultSchema]] as const).map(([side, schema]) =>
                    [JSON.stringify(schema), { label: `${action.id}:${side}`, schema }] as const)),
            ...Object.entries<MeasurableSchemaV1>({ ...structurallyBoundedSchemas, ...ownerBoundedSchemas,
                ...structurallyUnboundedSchemas,
                ...Object.fromEntries(Object.entries(TriageSourcesContributionProtocolV1.operations).flatMap(([role, operation]) => [
                    [`source/${role}/input`, operation.declaration.input.schema],
                    [`source/${role}/result`, operation.declaration.resultSchema],
                ])),
            }).map(([label, schema]) => [JSON.stringify(schema.jsonSchema), { label, schema: schema.jsonSchema, parse: (value: unknown) => schema.parse(value) }] as const),

        ]);
        for (const { label, schema, parse } of schemas.values()) {
            let maximal: unknown;
            try { maximal = buildMaximalSchemaValue(schema, label); }
            catch (error) {
                // Provider-sized sets have no structural maximum; the
                // separate oversized-envelope test exercises their owner.
                if (error instanceof Error && /unbounded/u.test(error.message)) continue;
                throw error;
            }
            expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(schema), maximal), label).toBe(true);
            expect(admits(parse ? parse(maximal) : maximal), label).toBe(true);
        }
    }, 120_000);

    it('admits a valid resolved prompt beyond the removed aggregate ceiling', () => {
        const fixture = createTriageSourceV1Fixture();
        const value = TriageStartEntrySessionInputV1Schema.parse({
            v: 1, workspaceMode: 'reference_only',
            entryRef: fixture.detailInput.observation.entryRef,
            display: { locator: fixture.detailInput.observation.locator, scopeLabel: 'example/repository' },
            destination: { kind: 'existing', sessionId: 'session-budget-fixture' },
            delivery: { kind: 'send', text: 'x'.repeat(1_024 * 1_024 + 1),
                attachments: [], idempotencyKey: 'prompt-budget-delivery' },
        });
        expect(encodedJsonBytes(value)).toBeGreaterThan(1_024 * 1_024);
        expect(admits(value)).toBe(true);
    });

    /** `PLAN.md` §0a A9 retains one page size independently of source count. */
    it('keeps the explicit row cap independent of lane count', () => {
        expect(triageListRowBudgetV1(0)).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(triageListRowBudgetV1(1)).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(triageListRowBudgetV1(MAX_TRIAGE_LIST_SOURCE_BATCH_V1))
            .toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
    });

    /**
     * The saved-view results are the one place a structural maximum would ask
     * for a product bound to shrink for a value that cannot occur. What has to
     * hold instead is that the owner's whole-value ceiling — the thing that
     * actually decides how large the stored set can be — leaves this result
     * comfortably inside the gate.
     */
    it('keeps Account-KV-bounded catalog results inside the gate at their real ceilings', () => {
        // The stored set is all either result carries beyond a handful of small
        // constant members, so a value of the ceiling's size plus a kilobyte of
        // room for them is the widest either Action can return. It is a byte
        // stand-in on purpose: the gate measures bytes, and it is the real gate
        // rather than a copy of its constant that answers here.
        const shell = {
            v: 1,
            availability: 'parsed',
            views: '',
            revision: 'revision-1',
        };
        for (const bytes of [
            MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 + 1_024,
            MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 + 1_024,
        ]) {
            const widest = {
                ...shell,
                views: 'a'.repeat(Math.max(bytes - encodedJsonBytes(shell), 0)),
            };

            expect(encodedJsonBytes(widest)).toBe(bytes);
            expect(admits(widest)).toBe(true);
        }
    });

    it('leaves provider-sized relationships valid while the canonical host rejects an oversized result envelope', () => {
        const observed = createTriageSourceV1Fixture().getResult;
        if (observed.kind !== 'present') throw new Error('The public fixture must provide a present entry');
        // Exercise the same byte boundary with wide valid references, avoiding
        // the unrelated cost of parsing thousands of tiny fixture objects.
        const relation = TriageEntryRefV1Schema.parse(buildMaximalSchemaValue(
            TriageEntryRefV1Schema.jsonSchema, 'oversizedTaskRelation',
        ));
        const relationBytes = encodedJsonBytes(relation) + 1;
        const result = TriageTaskWriteResultV1Schema.parse({
            kind: 'applied', observation: { ...observed, snapshot: { ...observed.snapshot,
                relations: { blockedBy: Array.from({ length: Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / relationBytes) + 1 }, () => relation) },
            } },
        });
        expect(admits(result)).toBe(true);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(false);
    });
});
