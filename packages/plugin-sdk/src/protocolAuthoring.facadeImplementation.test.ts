import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
    compilePluginJsonSchema,
    defineProtocolArray as canonicalDefineProtocolArray,
    defineProtocolLiteral as canonicalDefineProtocolLiteral,
    defineProtocolUnion as canonicalDefineProtocolUnion,
    defineProtocolUniqueArray as canonicalDefineProtocolUniqueArray,
    isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
    type ProtocolComposableSchema,
} from './protocol/protocolFacade.js';

const protocolAuthoringFacadeSource = fileURLToPath(
    new URL('./protocol/protocolFacade.ts', import.meta.url),
);
const retiredProtocolSchemaSource = fileURLToPath(
    new URL('./protocolSchema.ts', import.meta.url),
);

describe('protocol-authoring composition algebra', () => {
    it('owns parser-first data construction and one frozen structural projection', () => {
        expect(canonicalDefineProtocolLiteral).toBeTypeOf('function');
        expect(defineProtocolLiteral).toBe(canonicalDefineProtocolLiteral);
        expect(defineProtocolArray).toBe(canonicalDefineProtocolArray);
        expect(defineProtocolUniqueArray).toBe(canonicalDefineProtocolUniqueArray);
        expect(defineProtocolUnion).toBe(canonicalDefineProtocolUnion);
        const protocol = defineProtocolObject({
            kind: defineProtocolUnion([
                defineProtocolLiteral('issue'),
                defineProtocolLiteral('pull-request'),
            ]),
            title: defineProtocolString({ minLength: 1, maxLength: 8, pattern: '^[A-Z]+$' }),
            note: defineProtocolUtf8String({ maxUtf8Bytes: 4, minLength: 1 }).optional(),
            retries: defineProtocolNumber({ integer: true, minimum: 0, maximum: 3 }),
            tags: defineProtocolArray(defineProtocolString({ minLength: 1 }), {
                minItems: 1,
                maxItems: 2,
            }),
        }, { policy: 'closed' });
        const validates = compilePluginJsonSchema(protocol.jsonSchema);
        const publicSchema = protocol;

        type ParsedSchema = ReturnType<typeof publicSchema.parse>;
        expectTypeOf<keyof ParsedSchema>().toEqualTypeOf<'kind' | 'title' | 'note' | 'retries' | 'tags'>();
        expectTypeOf<ParsedSchema['kind']>().toEqualTypeOf<'issue' | 'pull-request'>();
        expectTypeOf<ParsedSchema['title']>().toEqualTypeOf<string>();
        expectTypeOf<ParsedSchema['note']>().toEqualTypeOf<string | undefined>();
        expectTypeOf<ParsedSchema['retries']>().toEqualTypeOf<number>();
        expectTypeOf<ParsedSchema['tags']>().toEqualTypeOf<readonly string[]>();
        expect(publicSchema).toBe(protocol);
        expect(publicSchema.safeParse({
            kind: 'issue',
            title: 'READY',
            note: 'éé',
            retries: 2,
            tags: ['one'],
        })).toEqual({
            success: true,
            data: {
                kind: 'issue',
                title: 'READY',
                note: 'éé',
                retries: 2,
                tags: ['one'],
            },
        });
        expect(publicSchema.safeParse({
            kind: 'issue',
            title: 'ready',
            retries: 2,
            tags: ['one'],
        }).success).toBe(false);
        const nestedFailure = publicSchema.safeParse({
            kind: 'issue',
            title: 'READY',
            retries: 2,
            tags: ['one', ''],
        });
        expect(nestedFailure).toMatchObject({
            success: false,
            error: { issues: [{ path: ['tags', 1] }] },
        });
        expect(publicSchema.safeParse({
            kind: 'issue',
            title: 'READY',
            retries: 2,
            tags: ['one'],
            extra: true,
        }).success).toBe(false);
        expect(isValidPluginJsonSchemaValue(validates, {
            kind: 'issue',
            title: 'READY',
            note: 'éé',
            retries: 2,
            tags: ['one'],
        })).toBe(true);
        const utf8Overflow = {
            kind: 'issue',
            title: 'READY',
            note: 'ééé',
            retries: 2,
            tags: ['one'],
        };
        expect(publicSchema.safeParse(utf8Overflow).success).toBe(false);
        expect(validates(utf8Overflow)).toBe(false);

        const unboundedInteger = defineProtocolNumber({ integer: true });
        const validatesInteger = compilePluginJsonSchema(unboundedInteger.jsonSchema);
        for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
            expect(unboundedInteger.safeParse(value).success).toBe(true);
            expect(validatesInteger(value)).toBe(true);
        }
        for (const value of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]) {
            expect(unboundedInteger.safeParse(value).success).toBe(false);
            expect(validatesInteger(value)).toBe(false);
        }
        expect(unboundedInteger.jsonSchema).toMatchObject({
            type: 'integer',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
        });
        const boundedUtf8 = defineProtocolUtf8String({ maxUtf8Bytes: 4 });
        const validatesUtf8 = compilePluginJsonSchema(boundedUtf8.jsonSchema);
        expect(boundedUtf8.jsonSchema).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string',
            'x-happier-max-utf8-bytes': 4,
        });
        expect(boundedUtf8.safeParse('\uD800').success).toBe(false);
        expect(validatesUtf8('\uD800')).toBe(false);
        expect(Object.isFrozen(publicSchema.jsonSchema)).toBe(true);
        expect(Object.isFrozen(publicSchema.jsonSchema.properties)).toBe(true);
        expect(Reflect.has(publicSchema, '~standard')).toBe(false);
    });

    it('keeps explicit open-object policy and typed additional properties at the same owner', () => {
        const drop = defineProtocolObject({
            state: defineProtocolLiteral('ready'),
        }, { policy: 'additive-open/drop' });
        const preserve = defineProtocolObject({
            state: defineProtocolLiteral('ready'),
        }, {
            policy: 'additive-open/preserve',
            additionalProperties: defineProtocolNumber({ integer: true, minimum: 0 }),
        });

        type PreservedObject = ReturnType<typeof preserve.parse>;
        type PreservedInput = typeof preserve extends ProtocolComposableSchema<infer TInput, infer _TOutput>
            ? TInput
            : never;
        const input: PreservedInput = { state: 'ready', attempt: 1 };
        const output: PreservedObject = { state: 'ready', attempt: 1 };

        expectTypeOf<PreservedObject['state']>().toEqualTypeOf<'ready'>();
        expectTypeOf<PreservedObject['attempt']>().toEqualTypeOf<number | 'ready'>();
        expectTypeOf<typeof input.state>().toEqualTypeOf<'ready'>();
        expectTypeOf<typeof input.attempt>().toEqualTypeOf<number | 'ready'>();
        expectTypeOf<PreservedObject>().toMatchTypeOf<Readonly<{
            state: 'ready';
        }>>();
        expect(input).toEqual({ state: 'ready', attempt: 1 });
        expect(output).toEqual({ state: 'ready', attempt: 1 });

        const optionalKnown = defineProtocolObject({
            state: defineProtocolLiteral('ready').optional(),
        }, {
            policy: 'additive-open/preserve',
            additionalProperties: defineProtocolNumber({ integer: true, minimum: 0 }),
        });
        type OptionalKnownObject = ReturnType<typeof optionalKnown.parse>;
        const optionalKnownOutput: OptionalKnownObject = { attempt: 1 };

        expectTypeOf<OptionalKnownObject['state']>().toEqualTypeOf<'ready' | undefined>();
        expectTypeOf<OptionalKnownObject['attempt']>().toEqualTypeOf<number | 'ready'>();
        expect(optionalKnownOutput).toEqual({ attempt: 1 });
        expect(optionalKnown.parse({ attempt: 1 })).toEqual({ attempt: 1 });

        expect(drop.parse({ state: 'ready', ignored: 1 })).toEqual({ state: 'ready' });
        expect(preserve.parse({ state: 'ready', attempt: 1 })).toEqual({ state: 'ready', attempt: 1 });
        expect(preserve.safeParse({ state: 'ready', attempt: 'one' })).toMatchObject({
            success: false,
            error: { issues: [{ path: ['attempt'] }] },
        });
        expect(preserve.safeParse({ state: 'ready', attempt: 'ready' })).toMatchObject({
            success: false,
            error: { issues: [{ path: ['attempt'] }] },
        });
        expect(preserve.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0 },
        });
    });

    it('projects recursively readonly object and array author values', () => {
        const schema = defineProtocolObject({
            metadata: defineProtocolObject({
                labels: defineProtocolArray(defineProtocolObject({
                    name: defineProtocolString(),
                }, { policy: 'closed' })),
            }, { policy: 'closed' }),
        }, { policy: 'closed' });

        expectTypeOf<ReturnType<typeof schema.parse>>().toEqualTypeOf<Readonly<{
            metadata: Readonly<{
                labels: readonly Readonly<{ name: string }>[];
            }>;
        }>>();
    });

    it('retains the exact readonly object projection through a direct array', () => {
        const schema = defineProtocolArray(defineProtocolObject({
            name: defineProtocolString(),
        }, { policy: 'closed' }));

        expectTypeOf<ReturnType<typeof schema.parse>>().toEqualTypeOf<ReadonlyArray<Readonly<{
            name: string;
        }>>>();
    });

    it('rejects invalid public data options at construction', () => {
        expect(() => defineProtocolLiteral(Number.NaN)).toThrow(/finite/i);
        expect(() => defineProtocolString({ minLength: 2, maxLength: 1 })).toThrow(/maxLength/i);
        expect(() => defineProtocolString({ pattern: '[' })).toThrow(/pattern/i);
        expect(() => defineProtocolNumber({ integer: true, minimum: 0.5 })).toThrow(/integer/i);
        expect(() => defineProtocolArray(defineProtocolLiteral('value'), {
            minItems: 2,
            maxItems: 1,
        })).toThrow(/maxItems/i);
        expect(() => Reflect.apply(defineProtocolUnion, undefined, [[defineProtocolLiteral('only')]]))
            .toThrow(/at least two/i);
    });

    it('keeps the public facade structural and free of validator and Standard Schema surface', async () => {
        const source = await readFile(protocolAuthoringFacadeSource, 'utf8');
        expect(source).not.toMatch(/\b_zod\b/u);
        expect(source).not.toContain('ProtocolAuthoringCompositionInternals');
        expect(source).not.toContain('~standard');
        expect(source).not.toContain('adoptProtocolSchema');
        expect(source).not.toContain('defineProtocolSchema');
        expect(source).not.toContain('ProtocolAuthoringSchema');
        expect(source).not.toContain('PublicProtocolSchema');
        expect(source).not.toContain('definedSchemaInput');
        expect(source).not.toContain('definedSchemaOutput');
        expect(source).not.toContain('schemaTypeEvidence');
        expect(source).not.toContain('Reflect.apply');
        expect(source).toContain('canonicalDefineProtocolLiteral');
        expect(source).toContain("from '@happier-dev/protocol/plugins/actions/json-schema-validation'");
    });

    it('removes the retired private authoring/adoption dialect after its consumers migrate', async () => {
        await expect(access(retiredProtocolSchemaSource)).rejects.toThrow();
    });

    it('projects canonical SDK roots through the same neutral composable contract', async () => {
        const [manifest, sessions, automations, targetedContributions, connectedAccounts] = await Promise.all([
            readFile(new URL('./manifest.ts', import.meta.url), 'utf8'),
            readFile(new URL('./services/sessions.ts', import.meta.url), 'utf8'),
            readFile(new URL('./automations.ts', import.meta.url), 'utf8'),
            readFile(new URL('./targetedContributionAuthoring.ts', import.meta.url), 'utf8'),
            readFile(new URL('./connectedAccounts.ts', import.meta.url), 'utf8'),
        ]);

        expect(manifest).toContain(
            'PluginContributionIdentityV1Schema: ProtocolComposableSchema<PluginContributionIdentity>',
        );
        expect(manifest).toContain('PluginIdSchema: ProtocolComposableSchema<string>');
        expect(sessions).toContain(
            'AgentPermissionIntentV1Schema: ProtocolComposableSchema<AgentPermissionIntentV1>',
        );
        expect(sessions).toContain('SessionIdSchema: ProtocolComposableSchema<SessionId>');
        expect(automations).toMatch(
            /export\s*\{[^}]*\bAutomationIdV1Schema\b[^}]*\}\s*from '@happier-dev\/protocol\/automations\/result-delivery';/u,
        );
        expect(automations).not.toContain('canonicalAutomationIdV1Schema');
        expect(automations).not.toContain('export const AutomationIdV1Schema');
        expect(targetedContributions).toContain(
            'PluginTargetedContributionSelectionV1Schema: ProtocolComposableSchema<PluginTargetedContributionSelectionV1>',
        );
        expect(connectedAccounts).toContain(
            "QualifiedConnectedAccountRefJsonSchema,\n    QualifiedConnectedAccountRefSchema,\n} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';",
        );
        expect(connectedAccounts).not.toContain('canonicalQualifiedConnectedAccountRefSchema');
        expect(connectedAccounts).not.toContain('export const QualifiedConnectedAccountRefSchema');
    });
});
