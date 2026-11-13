import fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import * as mini from 'zod/mini';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { admitResponse, enableSchemaValidation } from './enableSchemaValidation';

describe('API schema admission', () => {
    it('shares one parser handle for a canonical definition across routes and generated HEAD routes', async () => {
        const shared = lazyZodSchema(() => z.strictObject({ value: z.string() }));
        const concrete = z.strictObject({ value: z.string() });
        const first = { response: { 200: shared } };
        const second = { response: { 200: shared } };
        const built = { response: { 200: concrete } };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        app.get('/first', { schema: first }, async () => ({ value: 'kept' }));
        app.get('/second', { schema: second }, async () => ({ value: 'kept' }));
        app.get('/built', { schema: built }, async () => ({ value: 'kept' }));
        try {
            await app.ready();
            expect(first.response[200]).toBe(second.response[200]);
            expect(built.response[200]).toBe(concrete);
            expect((await app.inject('/first')).json()).toEqual({ value: 'kept' });
        } finally {
            await app.close();
        }
    });
    it('admits a producer-parsed response once and still validates every other payload', async () => {
        let parses = 0;
        const counted = () => z.strictObject({ value: z.string() }).check(z.refine(() => { parses++; return true; }));
        const response = lazyZodSchema(counted);
        const other = lazyZodSchema(() => z.object({ value: z.string(), extra: z.optional(z.boolean()) }));
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        app.get('/admitted', { schema: { response: { 200: response } } }, async () => admitResponse(response, { value: 'kept' }));
        app.get('/plain', { schema: { response: { 200: response } } }, async () => ({ value: 'kept' }));
        // Admission by another schema is not admission by this route's contract.
        app.get('/foreign', { schema: { response: { 200: response } } }, async () => admitResponse(other, { value: 'kept', extra: true }) as never);
        try {
            await app.ready();
            parses = 0;
            const admitted = await app.inject('/admitted');
            expect(admitted.json()).toEqual({ value: 'kept' });
            expect(parses).toBe(1);
            parses = 0;
            expect((await app.inject('/plain')).json()).toEqual({ value: 'kept' });
            expect(parses).toBe(1);
            const foreign = await app.inject('/foreign');
            expect(foreign.statusCode).toBe(500);
            expect(foreign.json().code).toBe('FST_ERR_RESPONSE_SERIALIZATION');
        } finally {
            await app.close();
        }
    });
    it('keeps registered definitions cold until request or response data needs them', async () => {
        let inputs = 0;
        let outputs = 0;
        const body = lazyZodSchema(() => {
            inputs++;
            return z.strictObject({ value: z.string().check(z.trim(), z.minLength(1)) });
        });
        const response = lazyZodSchema(() => {
            outputs++;
            return z.strictObject({ value: z.string().check(z.minLength(1)) });
        });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        app.post('/', { schema: { body, response: { 200: response } } }, async request =>
            request.body.value === 'leak' ? { ...request.body, extra: true } : request.body);
        try {
            await app.ready();
            expect({ inputs, outputs }).toEqual({ inputs: 0, outputs: 0 });
            const rejected = await app.inject({ method: 'POST', url: '/', payload: { value: 'kept', extra: true } });
            expect(rejected.statusCode).toBe(400);
            expect({ inputs, outputs }).toEqual({ inputs: 1, outputs: 0 });
            for (let index = 0; index < 2; index++) {
                const accepted = await app.inject({ method: 'POST', url: '/', payload: { value: ' kept ' } });
                expect(accepted.statusCode).toBe(200);
                expect(accepted.json()).toEqual({ value: 'kept' });
            }
            expect({ inputs, outputs }).toEqual({ inputs: 1, outputs: 1 });
            const badResponse = await app.inject({ method: 'POST', url: '/', payload: { value: 'leak' } });
            expect(badResponse.statusCode).toBe(500);
            expect(badResponse.json().code).toBe('FST_ERR_RESPONSE_SERIALIZATION');
        } finally {
            await app.close();
        }
    });

    it('preserves native Core/Mini schemas and the installed serializer envelope', async () => {
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        const core = new z.core.$ZodString({ type: 'string' });
        const small = mini.strictObject({ value: mini.string() });
        app.post('/core', { schema: { body: core, response: { 200: core } } }, async request => request.body);
        app.post('/mini', { schema: { body: small, response: { 200: small } } }, async request => request.body);
        app.get('/envelope', { schema: { response: { 200: { properties: z.strictObject({ value: z.string() }) } } } },
            async () => ({ value: 'kept' }));
        try {
            expect((await app.inject({ method: 'POST', url: '/core', payload: JSON.stringify(7), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
            const coreResult = await app.inject({ method: 'POST', url: '/core', payload: JSON.stringify('kept'), headers: { 'content-type': 'application/json' } });
            expect(coreResult.statusCode).toBe(200);
            expect(coreResult.payload).toBe('kept');
            expect((await app.inject({ method: 'POST', url: '/mini', payload: { value: 'kept', extra: true } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: '/mini', payload: { value: 'kept' } })).json()).toEqual({ value: 'kept' });
            expect((await app.inject('/envelope')).json()).toEqual({ value: 'kept' });
        } finally {
            await app.close();
        }
    });

    it('defers params, query and header definitions while retaining their constraints', async () => {
        const constructed = { params: 0, querystring: 0, headers: 0 };
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        app.get('/:id', { schema: {
            params: lazyZodSchema(() => { constructed.params++; return z.strictObject({ id: z.string().check(z.minLength(2)) }); }),
            querystring: lazyZodSchema(() => { constructed.querystring++; return z.strictObject({ count: z.coerce.number().check(z.int(), z.positive()) }); }),
            headers: lazyZodSchema(() => { constructed.headers++; return z.looseObject({ 'x-probe': z.string().check(z.minLength(2)) }); }),
        } }, async request => ({ id: request.params.id, count: request.query.count }));
        try {
            await app.ready();
            expect(constructed).toEqual({ params: 0, querystring: 0, headers: 0 });
            expect((await app.inject({ url: '/kept?count=2', headers: { 'x-probe': 'ok' } })).json()).toEqual({ id: 'kept', count: 2 });
            expect(constructed).toEqual({ params: 1, querystring: 1, headers: 1 });
            expect((await app.inject({ url: '/kept?count=-1', headers: { 'x-probe': 'ok' } })).statusCode).toBe(400);
            expect((await app.inject({ url: '/kept?count=2', headers: { 'x-probe': 'x' } })).statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
