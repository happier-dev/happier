import { describe, expect, it } from 'vitest';

import {
    DaemonPluginUiTargetedSurfaceMountV1Schema,
    rehydrateCanonicalProtocolComposableSchema,
    type DaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol';
import {
    defineProtocolJsonValue,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import {
    PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    derivePluginUiTargetedSurfaceMountInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';

import {
    createTargetedPluginSurfaceBoundFacts,
    projectTargetedPluginSurfacePhysicalMountFacts,
    readTargetedPluginSurfaceReactMountRequest,
    readTargetedPluginSurfaceMountRequest,
} from './TargetedPluginSurfaceHost';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import type { PluginSurfaceResourceReadTransport } from './pluginSurfaceResourceRead';
import type { PreparedDaemonPluginUiTargetedSurfaceMountV1 } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

function prepareTargetedMount(
    rawMount: DaemonPluginUiTargetedSurfaceMountV1,
): PreparedDaemonPluginUiTargetedSurfaceMountV1 {
    const inputValidation = preparePluginJsonSchema(rawMount.inputSchema);
    const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputValidation.jsonSchema);
    if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
    return Object.freeze({
        ...rawMount,
        inputSchema: inputValidation.jsonSchema,
        inputValidation,
        inputNormalizer,
    });
}

const target = Object.freeze({
    pluginId: 'acme.triage',
    immutableGenerationId: 'triage-generation-a',
});

const surface = Object.freeze({
    point: Object.freeze({
        pointId: 'triage-detail',
        protocol: Object.freeze({ id: 'triage/detail', version: 1 }),
    }),
    contributor: Object.freeze({
        pluginId: 'acme.review',
        contributionId: 'review-detail',
        immutableGenerationId: 'review-generation-b',
    }),
    role: 'detail',
    presentation: 'content' as const,
});

const rawMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
    kind: 'targetedSurface' as const,
    target,
    point: surface.point,
    contributor: surface.contributor,
    role: surface.role,
    presentation: surface.presentation,
    inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
    rendererChain: Object.freeze([Object.freeze({
        pluginId: 'acme.review',
        localId: 'review-detail',
    })]),
    selectedRenderer: Object.freeze({
        identity: Object.freeze({ pluginId: 'acme.review', localId: 'review-detail' }),
        renderer: Object.freeze({
            kind: 'declarative' as const,
            contributionId: 'review-detail',
            model: Object.freeze({
                visible: true,
                // This is the projection-response generation, not the B
                // immutable generation. Its B association comes from the
                // correlated producer-selected renderer mount below.
                identity: Object.freeze({
                    pluginId: 'acme.review',
                    localId: 'review-detail',
                    generation: 'projection-generation-11',
                }),
                root: Object.freeze({ kind: 'state', state: 'empty', title: 'No review selected' }),
            }),
        }),
        availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
    }),
    executionOrigin: Object.freeze({
        serverIdentityId: 'srv_server_a',
        materializationRef: Object.freeze({
            materializationId: 'review-materialization-b',
            machineId: 'machine-a',
            pluginId: 'acme.review',
        }),
    }),
    resourceCapability: Object.freeze({ readable: true, dynamic: true }),
    contributorTargetedContributions: Object.freeze({
        target: Object.freeze({
            pluginId: 'acme.review',
            immutableGenerationId: 'review-generation-b',
        }),
        points: Object.freeze([]),
    }),
});
const mount = prepareTargetedMount(rawMount);

const node = Object.freeze({
    kind: 'targetedSurface',
    surface,
    input: Object.freeze({ reviewId: 'review-42' }),
    instanceKey: `targeted-surface:v1:${'a'.repeat(64)}`,
});

function nestedLaunchInput(depth: number): PluginUiJsonValueV1 {
    let value: PluginUiJsonValueV1 = 'leaf';
    for (let index = 0; index < depth; index += 1) {
        value = { next: value };
    }
    return value;
}

function launchInputAtSerializedByteLength(byteLength: number): PluginUiJsonValueV1 {
    const empty = { reviewId: '' };
    const fixedBytes = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const input = { reviewId: 'x'.repeat(byteLength - fixedBytes) };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(byteLength);
    return input;
}

describe('readTargetedPluginSurfaceMountRequest', () => {
    it('admits an already-normalized declarative leaf only through its one exact correlated B mount', () => {
        const request = readTargetedPluginSurfaceMountRequest({
            node,
            mounts: [mount],
            target,
        });

        expect(request).toMatchObject({
            input: { reviewId: 'review-42' },
            instanceKey: node.instanceKey,
            mount: {
                kind: 'targetedSurface',
                mount,
            },
        });
        expect(request?.mount.mount.executionOrigin).toBe(mount.executionOrigin);
        expect(request?.mount.mount.contributorTargetedContributions)
            .toBe(mount.contributorTargetedContributions);

        const physical = projectTargetedPluginSurfacePhysicalMountFacts(request!);
        expect(physical).toMatchObject({
            pluginId: 'acme.review',
            contributionId: 'review-detail',
            surfaceId: `targeted:${node.instanceKey}`,
            mountInstanceKey: node.instanceKey,
            launchInput: { reviewId: 'review-42' },
            executionOrigin: mount.executionOrigin,
            resourceCapability: mount.resourceCapability,
            targetedContributions: mount.contributorTargetedContributions,
        });
        expect(physical).not.toHaveProperty('methodCeiling');
    });

    it('fails closed rather than retargeting a normalized A handle to a different B generation', () => {
        expect(readTargetedPluginSurfaceMountRequest({
            node,
            mounts: [prepareTargetedMount(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
                ...rawMount,
                contributor: Object.freeze({
                    ...mount.contributor,
                    immutableGenerationId: 'review-generation-c',
                }),
                contributorTargetedContributions: Object.freeze({
                    ...mount.contributorTargetedContributions,
                    target: Object.freeze({
                        ...mount.contributorTargetedContributions.target,
                        immutableGenerationId: 'review-generation-c',
                    }),
                }),
            }))],
            target,
        })).toBeNull();
    });

    it('does not treat symbolic authoring input as an already-normalized mounted leaf', () => {
        expect(readTargetedPluginSurfaceMountRequest({
            node: Object.freeze({
                ...node,
                surface: Object.freeze({
                    ...surface,
                    contributor: Object.freeze({
                        pluginId: surface.contributor.pluginId,
                        contributionId: surface.contributor.contributionId,
                    }),
                }),
            }),
            mounts: [mount],
            target,
        })).toBeNull();
    });

    it('validates launch input with the exact selected B pair on both entry paths', () => {
        const roleBoundMount = prepareTargetedMount(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            ...rawMount,
            inputSchema: defineProtocolObject({
                reviewId: defineProtocolString(),
            }, { policy: 'closed' }).jsonSchema,
        }));
        const readRequests = [
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceMountRequest({
                node: { ...node, input },
                mounts: [roleBoundMount],
                target,
            }),
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceReactMountRequest({
                presentation: { surface, input, instanceKey: 'review-42' },
                mounts: [roleBoundMount],
                target,
            }),
        ];

        for (const readRequest of readRequests) {
            // Wrong-implementation control: generic JSON admission would mount
            // this value, but B's correlated role schema must refuse it before
            // renderer or Resource-context disclosure.
            expect(readRequest({ reviewId: 42 })).toBeNull();
            expect(readRequest({ reviewId: 'review-42' })).toMatchObject({
                input: { reviewId: 'review-42' },
            });
        }
    });

    it('forwards canonical Surface parser output across declarative and React/RNW entry paths', () => {
        const mountFor = (policy: 'closed' | 'additive-open/drop' | 'additive-open/preserve') => {
            const inputSchema = defineProtocolObject({
                known: defineProtocolString(),
            }, { policy });
            return prepareTargetedMount(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
                ...rawMount,
                inputSchema: inputSchema.jsonSchema,
            }));
        };
        const readRequests = (mount: PreparedDaemonPluginUiTargetedSurfaceMountV1) => [
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceMountRequest({
                node: { ...node, input },
                mounts: [mount],
                target,
            }),
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceReactMountRequest({
                presentation: { surface, input, instanceKey: 'review-42' },
                mounts: [mount],
                target,
            }),
        ];

        for (const readRequest of readRequests(mountFor('additive-open/drop'))) {
            expect(readRequest({ known: 'kept', future: 'drop-me' })?.input).toEqual({ known: 'kept' });
        }
        for (const readRequest of readRequests(mountFor('additive-open/preserve'))) {
            expect(readRequest({ known: 'kept', future: 'retain-me' })?.input)
                .toEqual({ known: 'kept', future: 'retain-me' });
        }
        for (const readRequest of readRequests(mountFor('closed'))) {
            expect(readRequest({ known: 'kept', future: 'reject-me' })).toBeNull();
        }
    });

    it('admits deep strict launch input within the named aggregate ceiling and rejects maximum-plus-one bytes on both entry paths', () => {
        const readRequests = [
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceMountRequest({
                node: { ...node, input },
                mounts: [mount],
                target,
            }),
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceReactMountRequest({
                presentation: { surface, input, instanceKey: 'review-42' },
                mounts: [mount],
                target,
            }),
        ];
        // This exceeds the retired public depth quota while remaining far below
        // the owner-declared complete serialized-byte ceiling.
        const deepInput = nestedLaunchInput(128);
        expect(new TextEncoder().encode(JSON.stringify(deepInput)).byteLength)
            .toBeLessThan(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1);
        const atLimit = launchInputAtSerializedByteLength(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1);
        const overLimit = launchInputAtSerializedByteLength(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 + 1);

        for (const readRequest of readRequests) {
            expect(readRequest(deepInput)).toMatchObject({ input: deepInput });
            expect(readRequest(atLimit)).toMatchObject({ input: atLimit });
            expect(readRequest(overLimit)).toBeNull();
        }
    });

    it('retains strict rejection for cyclic, nonplain, and nonfinite declarative launch input', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        for (const value of [cyclic, new Date(), Number.NaN, Infinity]) {
            expect(readTargetedPluginSurfaceMountRequest({
                node: { ...node, input: value },
                mounts: [mount],
                target,
            })).toBeNull();
        }
    });

    it('keeps scalar and null Protocol launch inputs distinct from a rejected omitted input', () => {
        const unrestrictedMount = prepareTargetedMount(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            ...rawMount,
            inputSchema: defineProtocolJsonValue().jsonSchema,
        }));
        const readRequests = [
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceMountRequest({
                node: { ...node, input },
                mounts: [unrestrictedMount],
                target,
            }),
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceReactMountRequest({
                presentation: { surface, input, instanceKey: 'review-42' },
                mounts: [unrestrictedMount],
                target,
            }),
        ];

        for (const readRequest of readRequests) {
            for (const input of [null, false, 0, '']) {
                expect(readRequest(input)).toMatchObject({ input });
            }
        }
        expect(readTargetedPluginSurfaceMountRequest({
            node: {
                kind: 'targetedSurface',
                surface,
                instanceKey: node.instanceKey,
            },
            mounts: [unrestrictedMount],
            target,
        })).toBeNull();
    });

    it('namespaces a private React raw key through Main before mounting the exact B contributor', () => {
        const request = readTargetedPluginSurfaceReactMountRequest({
            presentation: Object.freeze({
                surface,
                input: Object.freeze({ reviewId: 'review-42' }),
                instanceKey: 'review-42',
            }),
            mounts: [mount],
            target,
        });

        expect(request).toMatchObject({
            input: { reviewId: 'review-42' },
            mount: {
                kind: 'targetedSurface',
                mount: {
                    contributor: surface.contributor,
                    executionOrigin: mount.executionOrigin,
                    contributorTargetedContributions: mount.contributorTargetedContributions,
                },
            },
        });
        expect(request?.instanceKey).toBe(derivePluginUiTargetedSurfaceMountInstanceKeyV1({
            targetPluginId: target.pluginId,
            surface,
            rawInstanceKey: 'review-42',
        }));
        expect(request?.instanceKey).not.toBe('review-42');
    });

    it('isolates the admitted launch input from its author source across both target entry paths', () => {
        const readRequests = [
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceMountRequest({
                node: { ...node, input },
                mounts: [mount],
                target,
            }),
            (input: PluginUiJsonValueV1) => readTargetedPluginSurfaceReactMountRequest({
                presentation: { surface, input, instanceKey: 'review-42' },
                mounts: [mount],
                target,
            }),
        ];

        for (const readRequest of readRequests) {
            const sourceInput = { review: { id: 'review-42' } };
            const request = readRequest(sourceInput);
            if (!request) throw new Error('Expected the exact test mount to be admitted.');

            const facts = createTargetedPluginSurfaceBoundFacts({
                request,
                serverId: 'server-a',
                sessionId: 'session-a',
                platform: 'web',
                channel: 'internal',
                projectionGeneration: 11,
                accountLifetime: null,
                interactionEnabled: true,
                daemonInteractionEnabled: true,
            });
            if (facts.resourceContext?.kind !== 'surface') {
                throw new Error('Expected the targeted child Resource context.');
            }
            const resourceInput = facts.resourceContext.launchInput as {
                readonly review: { readonly id: string };
            } | undefined;
            const publicInput = request.input as {
                readonly review: { readonly id: string };
            };

            expect(resourceInput).toBeTruthy();
            expect(publicInput).not.toBe(sourceInput);
            expect(resourceInput).not.toBe(sourceInput);
            // One admitted snapshot serves both consumers. Deep freezing — not a
            // second clone — is what keeps the renderer from reaching the
            // Resource context, so the two reading the same object is the
            // contract rather than a leak.
            expect(resourceInput).toBe(publicInput);
            expect(Object.isFrozen(publicInput)).toBe(true);
            expect(Object.isFrozen(publicInput.review)).toBe(true);
            expect(Object.isFrozen(resourceInput)).toBe(true);
            expect(Object.isFrozen(resourceInput?.review)).toBe(true);

            sourceInput.review.id = 'source-mutated';
            expect(publicInput.review.id).toBe('review-42');
            expect(resourceInput?.review.id).toBe('review-42');
            expect(Reflect.set(publicInput.review, 'id', 'public-mutated')).toBe(false);
            expect(resourceInput?.review.id).toBe('review-42');
        }
    });

    it('uses B for the child controller and stamps its Resource context from the exact physical mount', async () => {
        const request = readTargetedPluginSurfaceMountRequest({
            node,
            mounts: [mount],
            target,
        });
        if (!request) throw new Error('Expected the exact test mount to be admitted.');

        const accountLifetime = Object.freeze({
            scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
            isCurrent: () => true,
            onRetire: () => Object.freeze({ dispose(): void {} }),
        });
        const facts = createTargetedPluginSurfaceBoundFacts({
            request,
            serverId: 'server-a',
            sessionId: 'session-a',
            targetAuthorityKey: '["browser","target-a","https://first.example.test"]',
            platform: 'web',
            channel: 'internal',
            projectionGeneration: 11,
            accountLifetime,
            interactionEnabled: true,
            daemonInteractionEnabled: true,
        });

        expect(facts).toMatchObject({
            pluginId: 'acme.review',
            contributionId: 'review-detail',
            surfaceId: `targeted:${node.instanceKey}`,
            mountInstanceKey: node.instanceKey,
            targetAuthorityKey: '["browser","target-a","https://first.example.test"]',
            executionOrigin: mount.executionOrigin,
            targetedContributions: mount.contributorTargetedContributions,
            placement: 'unknown',
            resourceScope: [],
            resourceCapability: mount.resourceCapability,
            resourceContext: {
                kind: 'surface',
                mountInstanceKey: node.instanceKey,
                launchInput: { reviewId: 'review-42' },
            },
        });
        expect(facts).not.toHaveProperty('methodCeiling');

        const readRequests: unknown[] = [];
        const read: PluginSurfaceResourceReadTransport = async (machineId, options) => {
            readRequests.push({ machineId, ...options });
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'asset',
                    contentType: 'application/json',
                    digest: `sha256:${'a'.repeat(64)}`,
                    bytesBase64: 'e30=',
                },
            };
        };
        const controller = createBoundPluginSurfaceController({
            facts,
            binding: { readResource: read },
        });
        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        expect(controller.installedMethods).not.toContain('unsubscribeResource');
        await expect(controller.hostApi.handleRequest({
            version: 1,
            requestId: 'targeted-resource-read',
            surface: controller.surfaceContext,
            method: 'readResource',
            payload: { resource: 'review-summary' },
        } as never)).resolves.toMatchObject({ contentType: 'application/json' });
        expect(readRequests).toEqual([expect.objectContaining({
            machineId: 'machine-a',
            callerPluginId: 'acme.review',
            expectedGeneration: '11',
            resource: { pluginId: 'acme.review', localId: 'review-summary' },
            context: facts.resourceContext,
        })]);
        controller.dispose();
    });
});
