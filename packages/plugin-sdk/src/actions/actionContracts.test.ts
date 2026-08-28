import { describe, expect, expectTypeOf, it } from 'vitest';
import { definePlugin, type PluginActionDefinition } from '../definePlugin.js';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '../protocol/index.js';
import type {
    JsonValue,
    PluginContributionRef,
    PluginIdentity,
    PluginInvocationContributionIdentity,
} from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { PluginApi, PluginClientApi } from '../activation.js';
import type {
    AdmittedTargetedOperationExecutionHandle,
    ActionsService,
    PluginActionExecutionV2,
    PluginClientActionContext,
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
            execution: { target: 'daemon' },
            surfaces: ['plugin'],
            inputSchema: publishInputSchema,
            resultSchema: publishResultSchema,
            run: async (input) => ({ accepted: input.title.length > 0 }),
        },
        archive: {
            title: 'Archive',
            execution: { target: 'daemon' },
            surfaces: ['plugin'],
            inputSchema: archiveInputSchema,
            resultSchema: archiveResultSchema,
            run: async (input) => ({ archived: input.id.length > 0, id: input.id }),
        },
    },
});

describe('single-declaration Action contracts', () => {
    it('keeps admitted targeted-operation handles structurally compatible across SDK copies', () => {
        type Input = Readonly<{ id: string }>;
        type Result = Readonly<{ accepted: true }>;
        type LocalHandle = AdmittedTargetedOperationExecutionHandle<Input, Result, 'inspect'>;
        type IndependentSdkCopy = Readonly<{
            typeProjection: Readonly<{ input: Input; result: Result }> | undefined;
            identity: LocalHandle['identity'];
        }>;

        if (false) {
            const local = null as unknown as LocalHandle;
            const independent = null as unknown as IndependentSdkCopy;
            const acceptsIndependentCopy: LocalHandle = independent;
            const acceptsLocalCopy: IndependentSdkCopy = local;
            void acceptsIndependentCopy;
            void acceptsLocalCopy;
        }

        expect(true).toBe(true);
    });

    it('requires one closed author execution target with a relative client module path', () => {
        if (false) {
            const daemonExecution: PluginActionExecutionV2 = { target: 'daemon' };
            const clientExecution: PluginActionExecutionV2 = {
                target: 'client',
                client: {
                    artifactId: 'action-client',
                    modulePath: './runAction',
                    exportName: 'runAction',
                },
                platforms: ['web'],
            };
            const nonRelativeClientExecution: PluginActionExecutionV2 = {
                target: 'client',
                client: {
                    artifactId: 'action-client',
                    // @ts-expect-error Client Action modules are package-relative.
                    modulePath: 'runAction',
                    exportName: 'runAction',
                },
                platforms: ['web'],
            };
            void daemonExecution;
            void clientExecution;
            void nonRelativeClientExecution;

            definePlugin({
                id: 'acme.action-target-required',
                version: '1.0.0',
                actions: {
                    // @ts-expect-error Authored Actions cannot infer a daemon execution target.
                    missingTarget: {
                        title: 'Missing target',
                        run: async () => null,
                    },
                },
            });

            // @ts-expect-error Client Action handlers belong only to the client artifact activation.
            const invalidClientAction: PluginActionDefinition<{
                title: 'Open details';
                execution: {
                    target: 'client';
                    client: {
                        artifactId: 'action-client';
                        modulePath: './runAction';
                        exportName: 'activate';
                    };
                    platforms: readonly ['web'];
                };
                surfaces: readonly ['ui'];
            }> = {
                title: 'Open details',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: 'action-client',
                        modulePath: './runAction',
                        exportName: 'activate',
                    },
                    platforms: ['web'],
                },
                surfaces: ['ui'],
                run: async () => null,
            };
            void invalidClientAction;
        }

        const daemonExecution = { target: 'daemon' } satisfies PluginActionExecutionV2;
        expectTypeOf(daemonExecution).toMatchTypeOf<PluginActionExecutionV2>();
    });

    it('selects a client-safe handler context from the declared execution target', () => {
        if (false) {
            const clientApi = {} as PluginClientApi;
            clientApi.actions.register('openDetails', async (_input, context) => {
                const clientContext: PluginClientActionContext = context;
                const plugin: PluginIdentity = context.plugin;
                const contribution: PluginInvocationContributionIdentity = context.contribution;
                void context.signal;
                void context.invocationSurface;
                void context.currentUiContext;
                await context.ui.openSurface('details');
                // @ts-expect-error Client Action handlers never receive daemon services.
                void context.services;
                void clientContext;
                void plugin;
                void contribution;
                return null;
            });

            // @ts-expect-error Client activation does not expose daemon Agent registration.
            void clientApi.agents;
            // @ts-expect-error Client activation does not expose daemon Hook registration.
            void clientApi.hooks;

            const daemonApi = {} as PluginApi;
            daemonApi.actions.register('daemonAction', async (_input, context) => {
                const daemonContext: PluginInvocationContext = context;
                void daemonContext.services;
                return null;
            });
        }

        expect(true).toBe(true);
    });

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

    it('keeps runtime Action refs structural while preserving declaration-only input and result inference', () => {
        const contract = producer.actionContracts.publish;
        type IndependentSdkCopy = Readonly<{
            pluginId: 'acme.action-contracts';
            localId: 'publish';
            typeProjection: Readonly<{
                input: Readonly<{ title: string }>;
                result: Readonly<{ accepted: boolean }>;
            }> | undefined;
        }>;
        expectTypeOf<typeof contract>().toMatchTypeOf<Readonly<{
            pluginId: 'acme.action-contracts';
            localId: 'publish';
            typeProjection: Readonly<{
                input: Readonly<{ title: string }>;
                result: Readonly<{ accepted: boolean }>;
            }> | undefined;
        }>>();

        if (false) {
            const independent = null as unknown as IndependentSdkCopy;
            const acceptsIndependentCopy: typeof contract = independent;
            const acceptsLocalCopy: IndependentSdkCopy = contract;
            const actions = {} as ActionsService;
            const result = actions.execute(contract, { title: 'Release' });
            expectTypeOf(result).toEqualTypeOf<Promise<Readonly<{ accepted: boolean }>>>();
            const resultWithOrigin = actions.executeWithExecutionOrigin(contract, { title: 'Release' });
            expectTypeOf<Awaited<typeof resultWithOrigin>['result']>()
                .toEqualTypeOf<Readonly<{ accepted: boolean }>>();
            // @ts-expect-error The contract's declaration requires a title string.
            void actions.execute(contract, { id: 'release-1' });
            const raw: PluginContributionRef = {
                pluginId: 'acme.action-contracts',
                localId: 'publish',
            };
            const dynamicResult: Promise<JsonValue | void> = actions.execute(raw, { title: 'Release' });
            void dynamicResult;

            const archiveResult = actions.execute(producer.actionContracts.archive, { id: 'release-1' });
            expectTypeOf(archiveResult).toEqualTypeOf<Promise<Readonly<{
                archived: boolean;
                id: string;
            }>>>();
            void acceptsIndependentCopy;
            void acceptsLocalCopy;
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
