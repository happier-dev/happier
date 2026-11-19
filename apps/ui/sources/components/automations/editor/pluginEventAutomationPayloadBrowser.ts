import type {
    PluginJsonSchemaV2,
    PluginJsonValueV2,
} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { humanizeIdentifier } from '@/components/settings/home/governance/homeFeatureLabels';

/** One segment's words: the schema's declared title, else the key in words ("issueFingerprint" → "Issue fingerprint"). */
function segmentLabel(name: string, schema: PluginJsonSchemaV2): string {
    const title = typeof schema.title === 'string' ? schema.title.trim() : '';
    return title || humanizeIdentifier(name);
}

export type PluginEventAutomationPayloadScalarKind = 'string' | 'number' | 'boolean' | 'null';

export type PluginEventAutomationPayloadField = Readonly<{
    /** RFC 6901 pointer for one declared scalar payload leaf. */
    pointer: string;
    /** What a person reads: each segment's declared title, else its key in words, joined from the root. */
    label: string;
    scalarKind: PluginEventAutomationPayloadScalarKind;
    /** A conservative display/default value, never a schema-validation result. */
    sampleValue: null | boolean | number | string;
}>;

export type PluginEventAutomationPayloadBrowser = Readonly<{
    /** Static, declared scalar leaves only; dynamic and collection paths remain unavailable. */
    fields: readonly PluginEventAutomationPayloadField[];
    /** A display-only example derived from the declared static object shape. */
    samplePayload: PluginJsonValueV2 | null;
}>;

type ScalarSample = Readonly<{
    scalarKind: PluginEventAutomationPayloadScalarKind;
    value: null | boolean | number | string;
}>;

function escapePointerSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function scalarSampleFromValue(value: PluginJsonValueV2): ScalarSample | null {
    if (value === null) return { scalarKind: 'null', value: null };
    if (typeof value === 'string') return { scalarKind: 'string', value };
    if (typeof value === 'number') return { scalarKind: 'number', value };
    if (typeof value === 'boolean') return { scalarKind: 'boolean', value };
    return null;
}

function declaredScalarSample(schema: PluginJsonSchemaV2): ScalarSample | null {
    if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
        return scalarSampleFromValue(schema.const!);
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
        return scalarSampleFromValue(schema.default!);
    }
    return schema.enum ? scalarSampleFromValue(schema.enum[0]!) : null;
}

function readScalarSample(schema: PluginJsonSchemaV2): ScalarSample | null {
    // An optional nullable scalar still declares one editable leaf. Mixed scalar
    // unions and intersections do not supply one unambiguous control kind.
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (alternatives) {
        if (schema.anyOf && schema.oneOf || schema.allOf || schema.type !== undefined) return null;
        const samples = alternatives.map(readScalarSample);
        if (samples.some(sample => sample === null)) return null;
        const nonNull = samples.filter(sample => sample?.scalarKind !== 'null');
        return nonNull.length === 1 ? nonNull[0]! : null;
    }
    if (schema.allOf || schema.type === 'array') return null;
    const declared = declaredScalarSample(schema);
    if (schema.type === undefined) return declared;
    switch (schema.type) {
        case 'string':
            return declared?.scalarKind === 'string'
                ? declared
                : { scalarKind: 'string', value: '' };
        case 'number':
        case 'integer':
            return declared?.scalarKind === 'number'
                ? declared
                : { scalarKind: 'number', value: schema.minimum ?? 0 };
        case 'boolean':
            return declared?.scalarKind === 'boolean'
                ? declared
                : { scalarKind: 'boolean', value: true };
        case 'null':
            return { scalarKind: 'null', value: null };
        default:
            return null;
    }
}

type BrowseObjectResult = Readonly<{
    fields: readonly PluginEventAutomationPayloadField[];
    value: Readonly<Record<string, PluginJsonValueV2>>;
}>;

function browseDeclaredObject(
    schema: PluginJsonSchemaV2,
    pointerPrefix: string,
    labelPrefix: readonly string[] = [],
): BrowseObjectResult | null {
    if (
        schema.type !== 'object'
        || schema.additionalProperties !== false
        || schema.anyOf
        || schema.oneOf
        || schema.allOf
    ) {
        return null;
    }

    const fields: PluginEventAutomationPayloadField[] = [];
    const value: Record<string, PluginJsonValueV2> = {};
    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
        const pointer = `${pointerPrefix}/${escapePointerSegment(name)}`;
        const labels = [...labelPrefix, segmentLabel(name, propertySchema)];
        const scalar = readScalarSample(propertySchema);
        if (scalar) {
            fields.push(Object.freeze({
                pointer,
                label: labels.join(' · '),
                scalarKind: scalar.scalarKind,
                sampleValue: scalar.value,
            }));
            value[name] = scalar.value;
            continue;
        }
        const nested = browseDeclaredObject(propertySchema, pointer, labels);
        if (!nested) continue;
        fields.push(...nested.fields);
        value[name] = nested.value;
    }
    return Object.freeze({ fields: Object.freeze(fields), value: Object.freeze(value) });
}

function browseDeclaredRootAlternatives(
    schema: PluginJsonSchemaV2,
): BrowseObjectResult | null {
    // Root `oneOf`/`anyOf` declarations such as GitHub's discriminated Event
    // schema remain statically browseable. Composition mixed with an outer
    // object constraint would need an intersection evaluator, so it remains
    // unavailable rather than inventing fields outside Protocol's validator.
    const alternatives = schema.oneOf ?? schema.anyOf;
    if (
        !alternatives
        || schema.oneOf && schema.anyOf
        || schema.allOf
        || schema.type !== undefined
        || schema.properties !== undefined
        || schema.additionalProperties !== undefined
        || schema.items !== undefined
    ) {
        return null;
    }

    const branches = alternatives.flatMap((alternative) => {
        const browsed = browseDeclaredObject(alternative, '');
        return browsed ? [browsed] : [];
    });
    const firstBranch = branches[0];
    if (!firstBranch) return null;

    const seenPointers = new Set<string>();
    const fields: PluginEventAutomationPayloadField[] = [];
    for (const branch of branches) {
        for (const field of branch.fields) {
            if (seenPointers.has(field.pointer)) continue;
            seenPointers.add(field.pointer);
            fields.push(field);
        }
    }
    return Object.freeze({ fields: Object.freeze(fields), value: firstBranch.value });
}

/**
 * Derives the conservative visual affordances for the Event composer from a
 * declared strict payload schema. This is intentionally not an authoring
 * validator: durable semantic validation belongs to the Protocol/server
 * filter owner, which receives the chosen Event's current schema.
 */
export function buildPluginEventAutomationPayloadBrowser(
    payloadSchema: PluginJsonSchemaV2 | null | undefined,
): PluginEventAutomationPayloadBrowser {
    if (!payloadSchema) return Object.freeze({ fields: Object.freeze([]), samplePayload: null });
    const root = browseDeclaredObject(payloadSchema, '')
        ?? browseDeclaredRootAlternatives(payloadSchema);
    return root
        ? Object.freeze({ fields: root.fields, samplePayload: root.value })
        : Object.freeze({ fields: Object.freeze([]), samplePayload: null });
}
