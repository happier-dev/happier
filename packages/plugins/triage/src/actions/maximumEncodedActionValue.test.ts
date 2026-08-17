import { describe, expect, it } from 'vitest';

import { normalizeStrictJsonValue } from '@happier-dev/protocol';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    buildMaximalSchemaValue,
    deriveMaximumEncodedBytesByLabel,
    encodedJsonBytes,
    type MeasurableSchemaV1,
} from '@happier-dev/triage-protocol/testing/v1';

import {
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 } from '../settings/savedViews.js';
import {
    TriageReadEntryDetailInputV1Schema,
    TriageReadEntryDetailResultV1Schema,
} from './entryDetailProtocol.js';
import {
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
 * The aggregate's own side of the Action byte gate.
 *
 * `packages/triage-protocol/src/v1/maximumEncodedResult.test.ts` proves the
 * *source-facing* operation values fit. Nothing proved that this target's own
 * Action values do — and they cross the same gate. Every contributed Action
 * result is admitted by `normalizeStrictJsonValue`
 * (`packages/protocol/src/json/strictJsonValue.ts`) **before** the manifest
 * `resultSchema` is checked, and that owner throws
 * `JSON aggregate byte limit exceeded` rather than truncating: a result one
 * byte over is rejected whole, so the user sees no list at all rather than a
 * shorter one.
 *
 * The value measured here is the real one. `normalizeStrictJsonValue` is the
 * exact function the host boundary calls, not a copy of its constant, so a
 * later change to the ceiling reaches this test on its own.
 *
 * Nothing here is hand-built: the maximal values come from the one published
 * derivation in `@happier-dev/triage-protocol/testing/v1`, which the source
 * protocol's own maxima are derived with.
 */

/**
 * The values whose schema *is* their bound: nothing outside the shape limits
 * what they can carry, so the structural maximum is the reachable maximum and
 * it has to fit the gate on its own.
 */
const structurallyBoundedSchemas = {
    listEntriesInput: TriageListEntriesInputV1Schema,
    listEntriesResult: TriageListEntriesResultV1Schema,
    readEntryDetailInput: TriageReadEntryDetailInputV1Schema,
    readEntryDetailResult: TriageReadEntryDetailResultV1Schema,
    setEntryPinnedInput: TriageSetEntryPinnedInputV1Schema,
    setEntryPinnedResult: TriageSetEntryPinnedResultV1Schema,
    listPinnedEntriesInput: TriageListPinnedEntriesInputV1Schema,
    listPinnedEntriesResult: TriageListPinnedEntriesResultV1Schema,
    linkEntryToSessionInput: TriageLinkEntryToSessionInputV1Schema,
    linkEntryToSessionResult: TriageLinkEntryToSessionActionResultV1Schema,
    readSavedViewsInput: TriageReadSavedViewsInputV1Schema,
    administerSavedViewInput: TriageAdministerSavedViewInputV1Schema,
    // The two caller-bound source Actions are declared by this manifest, so
    // this plugin's own gate proof covers them too. `@happier-dev/triage-protocol`
    // derives them independently as the owner of their shapes; two pins over one
    // derivation is a second measurement, not a second bounds ledger, and it is
    // what lets the assertion below be "every declared schema" with no
    // exclusions to keep true.
    administerSourceInstanceInput: TriageSourceAdministrationActionInputV1Schema,
    administerSourceInstanceResult: TriageSourceAdministrationActionResultV1Schema,
    readConfiguredInstancesInput: TriageReadConfiguredSourceInstancesInputV1Schema,
    readConfiguredInstancesResult: TriageReadConfiguredSourceInstancesResultV1Schema,
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
    readSavedViewsResult: TriageReadSavedViewsResultV1Schema,
    administerSavedViewResult: TriageAdministerSavedViewResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

const measuredSchemas = { ...structurallyBoundedSchemas, ...ownerBoundedSchemas };

const derivedMaxima = deriveMaximumEncodedBytesByLabel(measuredSchemas);

function admits(value: unknown): boolean {
    try {
        normalizeStrictJsonValue(value);
        return true;
    } catch {
        return false;
    }
}

describe('the aggregate Action byte gate', () => {
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

    it('derives the exact maximum encoded bytes of every aggregate Action value', () => {
        // Pinned so that a widened bound, a raised count, a new field or a new
        // union arm reruns the derivation instead of silently consuming the
        // remaining headroom.
        expect(derivedMaxima).toEqual({
            readEntryDetailInput: 1_573,
            readEntryDetailResult: 79_899,
            listEntriesInput: 51_445,
            listEntriesResult: 976_334,
            setEntryPinnedInput: 5_670,
            setEntryPinnedResult: 27,
            listPinnedEntriesInput: 18,
            listPinnedEntriesResult: 318_165,
            linkEntryToSessionInput: 6_359,
            linkEntryToSessionResult: 25,
            readSavedViewsInput: 7,
            readSavedViewsResult: 1_572_322,
            administerSavedViewInput: 49_138,
            administerSavedViewResult: 1_572_347,
            administerSourceInstanceInput: 7_775,
            administerSourceInstanceResult: 81,
            readConfiguredInstancesInput: 7,
            readConfiguredInstancesResult: 266_066,
        });
    });

    /**
     * The list result is the one value whose size the product can still choose,
     * and the gate rejects it whole. Spending the last byte of the gate would
     * mean the next additive field anywhere beneath this schema fails at a
     * user's transport boundary — with the generic "result must be JSON-safe"
     * rejection — instead of failing in the derivation above. The window row
     * count is sized to keep a real margin, and this is what says so.
     */
    it('keeps real headroom under the gate rather than spending it to the last byte', () => {
        // A byte stand-in the real gate answers for, exactly as the saved-view
        // ceiling is measured: if the maximal list result plus this margin is
        // still admitted, the margin is genuinely there. Copying the gate's own
        // constant to subtract from would measure this file, not the boundary.
        const margin = 32 * 1_024;
        const padded = 'a'.repeat(derivedMaxima.listEntriesResult + margin - 2);

        expect(encodedJsonBytes(padded)).toBe(derivedMaxima.listEntriesResult + margin);
        expect(admits(padded)).toBe(true);
    });

    /**
     * The saved-view results are the one place a structural maximum would ask
     * for a product bound to shrink for a value that cannot occur. What has to
     * hold instead is that the owner's whole-value ceiling — the thing that
     * actually decides how large the stored set can be — leaves this result
     * comfortably inside the gate.
     */
    it('keeps the owner-bounded saved-view results inside the gate at their real ceiling', () => {
        // The ceiling has to be the smaller of the two, or it would not bind.
        expect(MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1)
            .toBeLessThan(derivedMaxima.readSavedViewsResult);

        // The stored set is all either result carries beyond a handful of small
        // constant members, so a value of the ceiling's size plus a kilobyte of
        // room for them is the widest either Action can return. It is a byte
        // stand-in on purpose: the gate measures bytes, and it is the real gate
        // rather than a copy of its constant that answers here.
        const shell = { v: 1, availability: 'parsed', views: '', selectedViewId: null };
        const bytes = MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 + 1_024;
        const widest = {
            ...shell,
            views: 'a'.repeat(Math.max(bytes - encodedJsonBytes(shell), 0)),
        };

        expect(encodedJsonBytes(widest)).toBe(bytes);
        expect(admits(widest)).toBe(true);
    });

    /**
     * Which value binds is the useful fact, because it says where the next
     * additive field will be paid for. Among the values the schema alone
     * bounds, a maximal window carries one snapshot per row, and that product —
     * the row count times the source protocol's own per-entry display bounds —
     * is four fifths of everything this plugin can return.
     */
    it('leaves the list result the binding structurally bounded value', () => {
        const others = Object.entries(derivedMaxima)
            .filter(([label]) => label !== 'listEntriesResult' && label in structurallyBoundedSchemas)
            .map(([, bytes]) => bytes);

        expect(derivedMaxima.listEntriesResult).toBeGreaterThan(Math.max(...others));
    });

    it('admits every maximal aggregate Action value through the owner that rejects it', () => {
        for (const [label, schema] of Object.entries<MeasurableSchemaV1>(structurallyBoundedSchemas)) {
            const maximal = schema.parse(buildMaximalSchemaValue(schema.jsonSchema, label));
            expect(admits(maximal), `${label} must be admitted by the host JSON gate`).toBe(true);
        }
    });

    /**
     * The assertion above is only worth its line if a real breach reaches it.
     * The list result is the one value whose size is a product of two counts,
     * so raising the row count is the cheapest true breach — and it has to be
     * rejected by the real owner without any help from a pinned total.
     */
    it('fails on a real breach rather than only on a changed pin', () => {
        const result = TriageListEntriesResultV1Schema.jsonSchema;
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

        expect(encodedJsonBytes(value)).toBeGreaterThan(derivedMaxima.listEntriesResult);
        expect(admits(value)).toBe(false);
    });
});
