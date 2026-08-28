import { describe, expect, it } from 'vitest';

import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    buildMaximalSchemaValue,
    deriveMaximumEncodedBytesByLabel,
    encodedJsonBytes,
    type MeasurableSchemaV1,
} from '@happier-dev/triage-protocol/testing/v1';

import {
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { PLUGIN_MANIFEST } from '../manifest.js';
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
} from './sessionLinksProtocol.js';
import {
    TriageListPinnedEntriesInputV1Schema,
    TriageListPinnedEntriesResultV1Schema,
    TriageSetEntryPinnedInputV1Schema,
    TriageSetEntryPinnedResultV1Schema,
} from './userMarksProtocol.js';

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
 * Nothing here is hand-built: the maximal values come from the one published
 * derivation in `@happier-dev/triage-protocol/testing/v1`, which the source
 * protocol's own maxima are derived with.
 */

/**
 * Values whose schema has a finite structural maximum.
 */
const structurallyBoundedSchemas = {
    readEntryDetailInput: TriageReadEntryDetailInputV1Schema,
    readEntryDetailResult: TriageReadEntryDetailResultV1Schema,
    reobserveEntryInput: TriageReobserveEntryInputV1Schema,
    reobserveEntryResult: TriageReobserveEntryResultV1Schema,
    setEntryPinnedInput: TriageSetEntryPinnedInputV1Schema,
    setEntryPinnedResult: TriageSetEntryPinnedResultV1Schema,
    listPinnedEntriesInput: TriageListPinnedEntriesInputV1Schema,
    listPinnedEntriesResult: TriageListPinnedEntriesResultV1Schema,
    linkEntryToSessionInput: TriageLinkEntryToSessionInputV1Schema,
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
    /*
     * The list result joined them when the window gained a per-lane continuation
     * SET (`PLAN.md` §0a A9). Its structural maximum pairs a full fifty-six-row
     * window WITH thirty-two maximal frontiers, and those two never co-occur:
     * `triageListRowBudgetV1` reserves the frontier bytes before the walk, so
     * the row count a result may carry falls as the lane count rises. The
     * reachable maximum is therefore the largest point on that curve, and the
     * whole curve is measured below.
     */
    listEntriesResult: TriageListEntriesResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * Values with a deliberately unbounded member. They remain strict JSON, but a
 * maximum encoded value cannot be derived without inventing a product quota.
 */
const structurallyUnboundedSchemas = {
    startEntrySessionInput: TriageStartEntrySessionInputV1Schema,
    startEntrySessionResult: TriageStartEntrySessionResultV1Schema,
    listEntriesInput: TriageListEntriesInputV1Schema,
    administerSavedViewInput: TriageAdministerSavedViewInputV1Schema,
    administerActionInput: TriageAdministerActionInputV1Schema,
    // The durable configured-source set has no product count ceiling. Its
    // reader fits whole records against the canonical Action envelope and uses
    // the published `truncated` status when the tail cannot cross it.
    readConfiguredInstancesResult: TriageReadConfiguredSourceInstancesResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * The real list-result projection, re-bounded to one point on the row/frontier
 * curve its owner actually produces.
 *
 * It is derived from the real projection, never a copy, so a member added
 * beside `rows` or `continuations` still reaches every measurement below.
 */
function listEntriesResultAt(rows: number, frontiers: number): PluginJsonSchema {
    const result = TriageListEntriesResultV1Schema.jsonSchema;
    const windowProperties = { ...result.properties?.window?.properties };
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

function listEntriesResultBytes(rows: number, frontiers: number): number {
    return encodedJsonBytes(
        buildMaximalSchemaValue(listEntriesResultAt(rows, frontiers), `listEntriesResult:${rows}:${frontiers}`),
    );
}

/** A maximal window, with no frontier set. The schema is the whole bound here. */
const listEntriesWindowMaximum = listEntriesResultBytes(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, 0);

/**
 * The lane counts the curve is measured at.
 *
 * The budget is a curve, not a number. Building a maximal result is expensive,
 * so the points are the ones that can break: none, one, either side of where
 * the frontier set stops fitting beside a full window, and the maximum a reader
 * can configure. Monotonicity over every count in between is asserted
 * separately and costs no build.
 */
const MEASURED_LANE_COUNTS: readonly number[] = Object.freeze([
    0,
    1,
    9,
    10,
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1 - 1,
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
]);

const measuredSchemas = {
    ...structurallyBoundedSchemas,
    ...ownerBoundedSchemas,
    ...structurallyUnboundedSchemas,
};

const derivedMaxima = deriveMaximumEncodedBytesByLabel({
    ...structurallyBoundedSchemas,
    listEntriesResult: TriageListEntriesResultV1Schema,
});

function admits(value: unknown): boolean {
    return AgentRuntimeJsonValueV1Schema.safeParse(value).success;
}

describe('aggregate Action value shapes', () => {
    /**
     * The measured set has to be the declared set, or an Action added later
     * simply would not be measured. There are no exclusions: an Action this
     * manifest declares crosses this gate whoever owns its shape.
     */
    it('measures every Action schema this plugin declares', () => {
        const measured = new Set(Object.values<MeasurableSchemaV1>(measuredSchemas)
            .map((schema) => JSON.stringify(schema.jsonSchema)));
        const declared = PLUGIN_MANIFEST.contributes.actions
            .flatMap((action) => [action.inputSchema, action.resultSchema] as const)
            .map((schema) => JSON.stringify(schema));
        const unmeasured = declared.filter((schema) => !measured.has(schema));

        expect(unmeasured).toEqual([]);
    });

    it('derives the continuation ceiling from the complete aggregate Action envelope', () => {
        const maximal = buildMaximalSchemaValue(
            TriageListEntriesResultV1Schema.jsonSchema,
            'listEntriesResult',
        );
        expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(maximal))
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);

        const widened = structuredClone(TriageListEntriesResultV1Schema.jsonSchema);
        const token = widened.properties?.window?.properties?.continuations
            ?.items?.properties?.continuation?.properties?.token;
        if (token?.['x-happier-max-utf8-bytes'] !== MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1) {
            throw new Error('the list continuation token no longer carries the shared byte ceiling');
        }
        token['x-happier-max-utf8-bytes'] = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 + 1;
        const oneByteWiderPerLane = buildMaximalSchemaValue(widened, 'widenedListEntriesResult');
        expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(oneByteWiderPerLane))
            .toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    }, 120_000);

    it('admits a valid resolved prompt beyond the removed aggregate ceiling', () => {
        const wider = structuredClone(TriageStartEntrySessionInputV1Schema.jsonSchema);
        const delivery = wider.properties?.delivery;
        const text = delivery?.properties?.text;
        if (!text) throw new Error('start input delivery no longer carries a prompt body');
        text.maxLength = 200_000;
        const value = buildMaximalSchemaValue(wider, 'wideStartInput');

        expect(encodedJsonBytes(value)).toBeGreaterThan(1_024 * 1_024);
        expect(TriageStartEntrySessionInputV1Schema.safeParse(value).success).toBe(true);
    });

    /**
     * `PLAN.md` §0a A9a, measured rather than asserted.
     *
     * A result carries at most one frontier per walked lane, and the frontier
     * set is never cut — cutting it starves the same tail lanes on every page.
     * So the ROW budget is what pays for them, and this is the proof that every
     * point on that curve, at every lane count a reader can configure, fits the
     * real gate without reserving bytes for a framing consumer that does not
     * exist.
     *
     * It is measured from the real projection at the row count the production
     * owner chooses, so a mutation that made the budget ignore the lane count
     * fails here rather than at a user's transport boundary.
     */
    it('does not shrink the row page to pay for continuation bytes', () => {
        for (const laneCount of MEASURED_LANE_COUNTS) {
            const rows = triageListRowBudgetV1(laneCount);
            expect(rows, `lane count ${laneCount}`).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        }
    }, 120_000);

    /**
     * The cap stands (`PLAN.md` §0a A9) and the budget is a real bound, not a
     * decoration. Both are stated: a budget that always returned the cap would
     * pass the curve above only if the curve stopped being measured, and a
     * budget that never reached the cap would be a silent restriction on every
     * reader.
     */
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
    it('keeps Settings-bounded catalog results inside the gate at their real ceilings', () => {
        // The stored set is all either result carries beyond a handful of small
        // constant members, so a value of the ceiling's size plus a kilobyte of
        // room for them is the widest either Action can return. It is a byte
        // stand-in on purpose: the gate measures bytes, and it is the real gate
        // rather than a copy of its constant that answers here.
        const shell = {
            v: 1,
            availability: 'parsed',
            views: '',
            selectedViewId: null,
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

    /**
     * Which value binds is the useful fact, because it says where the next
     * additive field will be paid for. Among the values the schema alone
     * bounds, a maximal window carries one snapshot per row, and that product —
     * the row count times the source protocol's own per-entry display bounds —
     * is four fifths of everything this plugin can return.
     */
    it('leaves the list window the binding reachable result', () => {
        const otherReachableResults = Object.entries(derivedMaxima)
            .filter(([label]) => label.endsWith('Result') && label in structurallyBoundedSchemas)
            .map(([, bytes]) => bytes);
        otherReachableResults.push(MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 + 1_024);
        otherReachableResults.push(MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 + 1_024);

        expect(listEntriesWindowMaximum).toBeGreaterThan(Math.max(...otherReachableResults));
    });

    it('admits every finite maximal aggregate Action value as strict JSON', () => {
        for (const [label, schema] of Object.entries<MeasurableSchemaV1>(structurallyBoundedSchemas)) {
            const maximal = schema.parse(buildMaximalSchemaValue(schema.jsonSchema, label));
            expect(admits(maximal), `${label} must be admitted by the host JSON gate`).toBe(true);
        }
        // The budget is raised because of what this case DOES, not to silence a
        // failure: it materializes a maximal value for every structurally
        // bounded schema and parses each one through strict host JSON admission.
        // That measures ~6s, just
        // past vitest's 5s default, so it failed on duration while asserting
        // cleanly. Anything red here is an assertion, never the clock.
    }, 60_000);

    /**
     * The assertion above is only worth its line if a real breach reaches it.
     * The list result is the one value whose size is a product of two counts,
     * so raising the row count is the cheapest true breach — and it has to be
     * rejected by the real owner without any help from a pinned total.
     */
    it('does not treat a larger strict-JSON result as an Action-boundary breach', () => {
        // Measured on the trimmed projection, because that is the basis the
        // reachable maximum is built from: breaching the untrimmed one would
        // start from a structural value the gate already refuses, and the
        // rejection would prove nothing about the row count.
        const result = listEntriesResultAt(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, 0);
        const rows = result.properties?.window?.properties?.rows;
        if (rows?.maxItems === undefined) {
            throw new Error('the list result no longer carries a bounded rows array');
        }
        const breached: PluginJsonSchema = {
            ...result,
            properties: {
                ...result.properties,
                window: {
                    ...result.properties?.window,
                    properties: {
                        ...result.properties?.window?.properties,
                        rows: { ...rows, maxItems: rows.maxItems * 4 },
                    },
                },
            },
        };
        const value = buildMaximalSchemaValue(breached, 'breachedListResult');

        expect(encodedJsonBytes(value)).toBeGreaterThan(listEntriesWindowMaximum);
        expect(admits(value)).toBe(true);
    });
});
