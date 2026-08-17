import { describe, expect, expectTypeOf, it } from 'vitest';
import { definePlugin } from '../definePlugin.js';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '../protocol/index.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type {
    AdmittedTargetedOperationExecutionHandle,
    ActionsService,
} from './index.js';

const publishInputSchema = defineProtocolObject({
    title: defineProtocolString(),
}, { policy: 'closed' });
const publishResultSchema = defineProtocolObject({
    accepted: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
}, { policy: 'closed' });
const archiveInputSchema = defineProtocolObject({
    id: defineProtocolString(),
}, { policy: 'closed' });
const archiveResultSchema = defineProtocolObject({
    archived: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
    id: defineProtocolString(),
}, { policy: 'closed' });

const producer = definePlugin({
    id: 'acme.action-contracts',
    version: '1.0.0',
    actions: {
        publish: {
            title: 'Publish',
            surfaces: ['plugin'],
            inputSchema: publishInputSchema,
            resultSchema: publishResultSchema,
            run: async (input) => ({ accepted: input.title.length > 0 }),
        },
        archive: {
            title: 'Archive',
            surfaces: ['plugin'],
            inputSchema: archiveInputSchema,
            resultSchema: archiveResultSchema,
            run: async (input) => ({ archived: input.id.length > 0, id: input.id }),
        },
    },
});

describe('single-declaration Action contracts', () => {
    it('derives frozen qualified refs from the one definePlugin declaration', () => {
        expect(producer.actionContracts).toEqual({
            publish: { pluginId: 'acme.action-contracts', localId: 'publish' },
            archive: { pluginId: 'acme.action-contracts', localId: 'archive' },
        });
        expect(Object.isFrozen(producer.actionContracts)).toBe(true);
        expect(Object.isFrozen(producer.actionContracts.publish)).toBe(true);
        expect(Object.isFrozen(producer.actionContracts.archive)).toBe(true);
        expect(Object.keys(producer.actionContracts)).toEqual(['publish', 'archive']);
    });

    it('keeps runtime Action refs structural while definePlugin owns handler inference', () => {
        const contract = producer.actionContracts.publish;
        expectTypeOf<typeof contract>().toEqualTypeOf<Readonly<{
            pluginId: 'acme.action-contracts';
            localId: 'publish';
        }>>();

        if (false) {
            const actions = {} as ActionsService;
            const result = actions.execute(contract, { title: 'Release' });
            expectTypeOf(result).toEqualTypeOf<Promise<JsonValue | void>>();
            const resultWithOrigin = actions.executeWithExecutionOrigin(contract, { title: 'Release' });
            expectTypeOf<Awaited<typeof resultWithOrigin>['result']>()
                .toEqualTypeOf<JsonValue | null>();
            const raw: PluginContributionRef = {
                pluginId: 'acme.action-contracts',
                localId: 'publish',
            };
            const dynamicResult: Promise<JsonValue | void> = actions.execute(raw, { title: 'Release' });
            void dynamicResult;

            const archiveResult = actions.execute(producer.actionContracts.archive, { id: 'release-1' });
            expectTypeOf(archiveResult).toEqualTypeOf<Promise<JsonValue | void>>();
        }
    });

    it('keeps admitted targeted operations on their opaque dedicated execution path', () => {
        if (false) {
            const operation = {} as AdmittedTargetedOperationExecutionHandle<
                { title: string },
                { accepted: boolean },
                'publish'
            >;
            const actions = {} as ActionsService;
            const result = actions.executeAdmittedTargetedOperation(operation, { title: 'Release' });
            expectTypeOf(result).toEqualTypeOf<Promise<{ accepted: boolean }>>();
            const resultWithOrigin = actions.executeAdmittedTargetedOperationWithExecutionOrigin(
                operation,
                { title: 'Release' },
            );
            expectTypeOf<Awaited<typeof resultWithOrigin>['result']>()
                .toEqualTypeOf<{ accepted: boolean }>();
            expectTypeOf<typeof operation.identity.role>().toEqualTypeOf<'publish'>();

            const reconstructedOperation = { identity: operation.identity };
            /* @sdk-negative-type-case:src-actions-actionContracts-test-ts-reconstructed:QSBkZXNjcmlwdGl2ZSBpZGVudGl0eSBjYW5ub3QgcmVjb25zdHJ1Y3QgYW4gYWRtaXR0ZWQgZXhlY3V0aW9uIGhhbmRsZS4:dm9pZCBhY3Rpb25zLmV4ZWN1dGVBZG1pdHRlZFRhcmdldGVkT3BlcmF0aW9uKHJlY29uc3RydWN0ZWRPcGVyYXRpb24sIHsgdGl0bGU6ICdSZWxlYXNlJyB9KTs */
            void undefined; /* @sdk-negative-type-case-end */

            /* @sdk-negative-type-case:src-actions-actionContracts-test-ts-generic:QW4gYWRtaXR0ZWQgb3BlcmF0aW9uIGNhbm5vdCBleGVjdXRlIHRocm91Z2ggdGhlIGdlbmVyaWMgQWN0aW9uIHBhdGgu:dm9pZCBhY3Rpb25zLmV4ZWN1dGUob3BlcmF0aW9uLCB7IHRpdGxlOiAnUmVsZWFzZScgfSk7 */
            void undefined; /* @sdk-negative-type-case-end */
            /* @sdk-negative-type-case:src-actions-actionContracts-test-ts-origin:QW4gYWRtaXR0ZWQgb3BlcmF0aW9uIGNhbm5vdCByZXF1ZXN0IGdlbmVyaWMgQWN0aW9uIG9yaWdpbiBjYXB0dXJlLg:dm9pZCBhY3Rpb25zLmV4ZWN1dGVXaXRoRXhlY3V0aW9uT3JpZ2luKG9wZXJhdGlvbiwgeyB0aXRsZTogJ1JlbGVhc2UnIH0pOw */
            void undefined; /* @sdk-negative-type-case-end */
        }
    });
});
