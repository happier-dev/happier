import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as m from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from './storedReadSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

describe('stored JSON schema derivation', () => {
    it('drops passthrough object extras but preserves declared map data', () => {
        const input = z.object({ fields: z.record(z.string(), z.unknown()) }).passthrough();
        expect(createStoredReadSchema(input).parse({ fields: { arbitrary: { retained: true } }, extra: true }))
            .toEqual({ fields: { arbitrary: { retained: true } } });
    });
    it('drops nested object extras without weakening required fields, refinements or inputs', () => {
        const input = z.object({
            ref: asProtocolZod(PluginContributionIdentityV1Schema),
            entries: z.record(z.string(), z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('value'), value: z.unknown() }).strict(),
                z.object({ kind: z.literal('context'), slot: z.string().min(1) }).strict(),
            ])),
        }).strict().refine(value => Object.keys(value.entries).length > 0);
        const stored = createStoredReadSchema(input);
        const canonical = { ref: { pluginId: 'happier.checks', localId: 'summary' }, entries: {
            first: { kind: 'context', slot: 'session' }, second: { kind: 'value', value: { arbitrary: 1 } },
        } };
        const raw = { ...canonical, savedBy: 'stray', ref: { ...canonical.ref, extra: true }, entries: {
            ...canonical.entries, first: { ...canonical.entries.first, extra: true },
        } };
        expect(stored.parse(raw)).toEqual(canonical);
        expect(raw).toHaveProperty('savedBy', 'stray');
        expect(input.safeParse(raw).success).toBe(false);
        expect(stored.safeParse({ ...raw, ref: { pluginId: 'happier.checks', extra: true } }).success).toBe(false);
        expect(stored.safeParse({ ...raw, entries: {} }).success).toBe(false);
    });
});

it('constructs a captured custom reader on demand without weakening admission', () => {
    const canonical = z.object({ value: z.string().trim().min(1) }).strict()
        .refine(value => value.value !== 'forbidden');
    let readProjectionReady = false;
    defineStoredReadProjection(canonical, () => {
        readProjectionReady = true;
        return canonical.strip();
    });

    const stored = createStoredReadSchema(canonical);
    expect(readProjectionReady).toBe(false);
    expect(createStoredReadSchema(canonical)).toBe(stored);

    // A later registration cannot replace the read contract already selected.
    defineStoredReadProjection(canonical, () => z.object({ value: z.literal('late') }).strict());
    const raw = { value: ' kept ', extra: true };
    expect(canonical.safeParse(raw).success).toBe(false);
    expect(stored.parse(raw)).toEqual({ value: 'kept' });
    expect(readProjectionReady).toBe(true);
    expect(createStoredReadSchema(canonical)).toBe(stored);
    expect(() => stored.parse({ value: 'forbidden' })).toThrow(z.ZodError);
    const refused = stored.safeParse({ value: 'forbidden' });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues).toMatchObject([{ code: 'custom', path: [] }]);
});

it('projects deferred Classic, Mini and Core readers with their concrete reference identity', () => {
    const classic = z.object({ value: z.string().min(1) }).strict();
    const classicRead = classic.strip().describe('Classic read');
    const mini = m.strictObject({ value: m.string().check(m.minLength(1)) });
    const miniRead = m.object({ value: m.string().check(m.minLength(1)) })
        .register(z.globalRegistry, { id: 'StoredReadMiniProjection', title: 'Mini read' });
    const core = new z.core.$ZodObject({
        type: 'object',
        shape: { value: new z.core.$ZodString({ type: 'string', checks: [] }) },
        catchall: new z.core.$ZodNever({ type: 'never' }),
    });
    const coreRead = new z.core.$ZodObject({
        type: 'object',
        shape: { value: new z.core.$ZodString({ type: 'string', checks: [] }) },
    });
    z.globalRegistry.add(coreRead, { title: 'Core read' });

    for (const [canonical, concreteRead] of [[classic, classicRead], [mini, miniRead], [core, coreRead]] as const) {
        defineStoredReadProjection(canonical, () => concreteRead);
        const stored = createStoredReadSchema(canonical);
        expect(createStoredReadSchema(canonical)).toBe(stored);
        const actual = z.object({ first: stored, second: stored, repeated: z.array(stored) });
        const expected = z.object({ first: concreteRead, second: concreteRead, repeated: z.array(concreteRead) });
        for (const target of ['draft-7', 'draft-2020-12'] as const) {
            for (const io of ['input', 'output'] as const) {
                expect(z.toJSONSchema(actual, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
            }
        }
        const raw = { value: 'kept', extra: true };
        expect(z.core.parse(stored, raw)).toEqual(z.core.parse(concreteRead, raw));
        const refused = z.core.safeParse(stored, { value: 42 });
        const expectedRefusal = z.core.safeParse(concreteRead, { value: 42 });
        expect(refused.success).toBe(false);
        if (!refused.success && !expectedRefusal.success) {
            expect(refused.error.constructor).toBe(expectedRefusal.error.constructor);
            expect(refused.error.issues).toEqual(expectedRefusal.error.issues);
        }
        if (canonical !== classic) expect(Reflect.get(stored, 'optional')).toBeUndefined();
    }

    const atomic = z.string().min(1).describe('Atomic value');
    const structural = z.object({ nested: z.object({ value: atomic.default('fallback') }).strict() }).strict();
    const structuralRead = z.object({ nested: z.object({ value: atomic.default('fallback') }).strip() }).strip();
    for (const [canonical, concreteRead] of [[atomic, atomic], [structural, structuralRead]] as const) {
        const stored = createStoredReadSchema(canonical);
        expect(createStoredReadSchema(canonical)).toBe(stored);
        for (const target of ['draft-7', 'draft-2020-12'] as const) {
            for (const io of ['input', 'output'] as const) {
                expect(z.toJSONSchema(stored, { target, io })).toEqual(z.toJSONSchema(concreteRead, { target, io }));
            }
        }
    }
    expect(createStoredReadSchema(atomic).parse('kept')).toBe('kept');
    expect(createStoredReadSchema(structural).parse({ nested: { extra: true }, extra: true }))
        .toEqual({ nested: { value: 'fallback' } });

    type RecursiveRead = { value: string; next?: RecursiveRead };
    const recursive: z.ZodType<RecursiveRead> = z.lazy(() => z.object({
        value: z.string(), next: recursive.optional(),
    }).strict());
    const recursiveRead: z.ZodType<RecursiveRead> = z.lazy(() => z.object({
        value: z.string(), next: recursiveRead.optional(),
    }).strip());
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
        for (const io of ['input', 'output'] as const) {
            expect(z.toJSONSchema(createStoredReadSchema(recursive), { target, io }))
                .toEqual(z.toJSONSchema(recursiveRead, { target, io }));
        }
    }
    expect(createStoredReadSchema(recursive).parse({ value: 'a', next: { value: 'b', extra: true } }))
        .toEqual({ value: 'a', next: { value: 'b' } });
});
