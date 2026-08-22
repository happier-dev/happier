import { describe, expect, it } from 'vitest';

import {
    ConversationDeliveryInputV1Schema,
} from '@happier-dev/channels-protocol/v1';
import {
    cloneStrictPluginJsonValue,
    normalizePluginJsonSchema,
    compilePluginJsonSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 15;
// A fixed workload for measurement only, not a Protocol acceptance limit.
const BENCHMARK_LARGE_ARRAY_LENGTH = 8_191;

type Measurement = Readonly<{
    medianMs: number;
    p95Ms: number;
    samples: number;
}>;

type BenchmarkCase = Readonly<{
    name: string;
    schema: ProtocolComposableSchema<unknown, unknown>;
    input: unknown;
    /** The public authoring definition, when the package exports it. */
    createSchema?: () => ProtocolComposableSchema<unknown, unknown>;
}>;

function roundMilliseconds(value: number): number {
    return Math.round(value * 1_000) / 1_000;
}

function measure(operation: () => unknown): Measurement {
    for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) operation();

    const elapsed: number[] = [];
    let lastResult: unknown;
    for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
        const startedAt = performance.now();
        lastResult = operation();
        elapsed.push(performance.now() - startedAt);
    }
    // Retain an observable use so every measured operation is executed.
    expect(lastResult).toBeDefined();
    elapsed.sort((left, right) => left - right);
    return {
        medianMs: roundMilliseconds(elapsed[Math.floor(elapsed.length / 2)]!),
        p95Ms: roundMilliseconds(elapsed[Math.ceil(elapsed.length * 0.95) - 1]!),
        samples: elapsed.length,
    };
}

const createSmallSchema = () => defineProtocolObject({
    id: defineProtocolString({ minLength: 1, maxLength: 64 }),
    enabled: defineProtocolUnion([
        defineProtocolLiteral(false),
        defineProtocolLiteral(true),
    ]),
}, { policy: 'closed' });
const smallSchema = createSmallSchema();

const createTargetedLaunchInputSchema = () => defineProtocolObject({
    reviewId: defineProtocolString({ minLength: 1, maxLength: 128 }),
    repository: defineProtocolObject({
        owner: defineProtocolString({ minLength: 1, maxLength: 128 }),
        name: defineProtocolString({ minLength: 1, maxLength: 128 }),
    }, { policy: 'closed' }),
    selection: defineProtocolObject({
        tab: defineProtocolUnion([
            defineProtocolLiteral('overview'),
            defineProtocolLiteral('files'),
            defineProtocolLiteral('checks'),
        ]),
        path: defineProtocolString({ minLength: 1, maxLength: 1_024 }).optional(),
        line: defineProtocolNumber({ integer: true, minimum: 1, maximum: 1_000_000 }).optional(),
    }, { policy: 'closed' }),
    launch: defineProtocolObject({
        source: defineProtocolUnion([
            defineProtocolLiteral('notification'),
            defineProtocolLiteral('command'),
            defineProtocolLiteral('deepLink'),
        ]),
        requestedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
}, { policy: 'closed' });
const targetedLaunchInputSchema = createTargetedLaunchInputSchema();

const createLargeInputSchema = () => defineProtocolArray(
    defineProtocolNumber({ integer: true }),
);
const largeInputSchema = createLargeInputSchema();

const channelsDeliveryInput = {
    v: 1,
    connectionId: 'connection-42',
    providerConnectionKey: 'provider:connection-42',
    providerConfigVersion: 1,
    providerConfig: { installation: 'installation-42', workspace: 'engineering' },
    credentialRef: null,
    endpoint: { kind: 'thread', audience: 'shared', id: 'thread-42' },
    content: 'A realistic bounded Channels delivery payload.',
    deliveryKey: 'binding-42:reply-42',
    replyContext: { replyToMessageId: 'message-42' },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
} as const;

const largeInput = Array.from(
    { length: BENCHMARK_LARGE_ARRAY_LENGTH },
    (_, index) => index,
);

const cases: readonly BenchmarkCase[] = [
    {
        name: 'small-schema',
        schema: smallSchema,
        input: { id: 'small-42', enabled: true },
        createSchema: createSmallSchema,
    },
    {
        name: 'channels-delivery',
        schema: ConversationDeliveryInputV1Schema,
        input: channelsDeliveryInput,
    },
    {
        name: 'targeted-launch-input',
        schema: targetedLaunchInputSchema,
        input: {
            reviewId: 'review-42',
            repository: { owner: 'acme', name: 'happier' },
            selection: { tab: 'files', path: 'apps/cli/src/index.ts', line: 42 },
            launch: { source: 'notification', requestedAtMs: 1_726_000_000_000 },
        },
        createSchema: createTargetedLaunchInputSchema,
    },
    {
        name: 'large-input',
        schema: largeInputSchema,
        input: largeInput,
        createSchema: createLargeInputSchema,
    },
];

/**
 * Reproducible protocol-schema phase measurement. Run with:
 *
 * HAPPIER_RUN_PROTOCOL_SCHEMA_BENCHMARK=1 yarn workspace @happier-dev/cli exec vitest run src/plugins/projection/registry/protocolSchema.benchmark.test.ts
 *
 * There is deliberately no timing threshold: the deciding evidence is the
 * separately reported phase data from the machine and candidate under review.
 */
describe.runIf(process.env.HAPPIER_RUN_PROTOCOL_SCHEMA_BENCHMARK === '1')(
    'Protocol schema lifecycle benchmark',
    () => {
        it('measures the separately attributable schema lifecycle phases across representative cases', () => {
            const preparedCases = cases.map((benchmarkCase) => {
                const strictInput = cloneStrictPluginJsonValue(
                    benchmarkCase.input,
                    'benchmark.input',
                );
                const parsed = benchmarkCase.schema.safeParse(strictInput);
                expect(parsed.success).toBe(true);
                if (!parsed.success) throw new Error(`Benchmark fixture ${benchmarkCase.name} must parse.`);

                // Keep every normalization input a distinct object. The
                // canonical normalizer intentionally recognizes already
                // normalized schema identities, so reusing one object would
                // benchmark the WeakSet fast path instead of normalization.
                const normalizationSources = Array.from(
                    { length: WARMUP_SAMPLES + MEASURED_SAMPLES },
                    () => cloneStrictPluginJsonValue(
                        benchmarkCase.schema.jsonSchema,
                        'benchmark.schema',
                    ),
                );

                return {
                    benchmarkCase,
                    strictInput,
                    parsedData: parsed.data,
                    normalizationSources,
                    validation: compilePluginJsonSchema(benchmarkCase.schema.jsonSchema),
                };
            });

            const measurements = preparedCases.map((preparedCase) => {
                let normalizationIndex = 0;
                return {
                    case: preparedCase.benchmarkCase.name,
                    protocolSchemaConstructionAndProjection: preparedCase.benchmarkCase.createSchema
                        ? measure(() => preparedCase.benchmarkCase.createSchema!())
                        : null,
                    strictClone: measure(() => cloneStrictPluginJsonValue(
                        preparedCase.benchmarkCase.input,
                        'benchmark.input',
                    )),
                    // ProtocolComposableSchema intentionally keeps its parser
                    // private. safeParse is therefore the canonical
                    // executable-parse boundary, and includes its required
                    // strict input clone, output clone, and projection check.
                    executableParse: measure(() => {
                        const result = preparedCase.benchmarkCase.schema.safeParse(preparedCase.strictInput);
                        if (!result.success) {
                            throw new Error(`Benchmark fixture ${preparedCase.benchmarkCase.name} must parse.`);
                        }
                        return result;
                    }),
                    // The projection is materialized by the public constructor
                    // before the public wrapper is returned. The public API
                    // exposes canonical normalization, but not a projection-
                    // only operation, so this phase measures normalization of
                    // fresh projected bytes and reports that limitation below.
                    jsonSchemaProjectionNormalization: measure(() => normalizePluginJsonSchema(
                        preparedCase.normalizationSources[normalizationIndex++]!,
                    )),
                    // compilePluginJsonSchema is the canonical AJV owner. It
                    // performs an identity normalization lookup before each
                    // compile; no second compiler or cache is introduced here.
                    ajvCompilation: measure(() => compilePluginJsonSchema(
                        preparedCase.benchmarkCase.schema.jsonSchema,
                    )),
                    ajvValidation: measure(() => {
                        if (!preparedCase.validation(preparedCase.strictInput)) {
                            throw new Error(`Benchmark fixture ${preparedCase.benchmarkCase.name} must validate.`);
                        }
                        return true;
                    }),
                    outputCloneAndFreeze: measure(() => cloneStrictPluginJsonValue(
                        preparedCase.parsedData,
                        'benchmark.output',
                    )),
                };
            });

            process.stdout.write(`PROTOCOL_SCHEMA_LIFECYCLE_BENCHMARK_V1 ${JSON.stringify({
                environment: {
                    node: process.version,
                    platform: process.platform,
                    arch: process.arch,
                },
                samples: { warmup: WARMUP_SAMPLES, measured: MEASURED_SAMPLES },
                phaseNotes: {
                    protocolSchemaConstructionAndProjection: 'Cold public constructor composition. This is the canonical indivisible parser-snapshot + JSON Schema projection + normalization + initial AJV compilation owner; the public API does not expose parser construction or projection-only operations. Channels uses its already-exported authoring schema, so this case reports null rather than duplicating the schema.',
                    strictClone: 'cloneStrictPluginJsonValue(input): immutable strict ordinary-JSON input copy.',
                    executableParse: 'ProtocolComposableSchema.safeParse(strictInput): strict input clone, executable parser, output clone, and retained projection validation; no parser-only public API exists.',
                    jsonSchemaProjectionNormalization: 'normalizePluginJsonSchema(fresh projected schema): canonical normalization only. Public constructor composition materializes projection before the schema is returned, and exposes no projection-only API.',
                    ajvCompilation: 'compilePluginJsonSchema(schema.jsonSchema): canonical AJV compilation with an identity normalization lookup; no global cache.',
                    ajvValidation: 'Retained canonical AJV validator on bounded input.',
                    outputCloneAndFreeze: 'cloneStrictPluginJsonValue(parsed.data): immutable strict ordinary-JSON output copy.',
                },
                measurements,
            })}\n`);
        });
    },
);
