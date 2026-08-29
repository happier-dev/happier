import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    createReactNativeCrashStateBindingKey,
    createReactNativeCrashStateStore,
    recordReactNativeCrashFailure,
    reconcileReactNativeCrashStateBindings,
    resetReactNativeCrashState,
    type ReactNativeCrashStateBinding,
} from './reactNativeCrashDisableState';

const renderer = { pluginId: 'runtime.plugin', localId: 'native-compatible' } as const;
const destinationOne = { pluginId: 'runtime.plugin', localId: 'preview-one' } as const;
const destinationTwo = { pluginId: 'runtime.plugin', localId: 'preview-two' } as const;
const targetedSurfaceOne = {
    kind: 'targetedSurface',
    target: { pluginId: 'runtime.target', immutableGenerationId: 'target-generation-one' },
    point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
    contributor: {
        pluginId: 'runtime.plugin',
        contributionId: 'provider-detail',
        immutableGenerationId: 'contributor-generation-one',
    },
    role: 'detail',
    presentation: 'content',
} as const;
const inlineSurfaceOne = {
    kind: 'inline',
    surface: { pluginId: 'runtime.plugin', localId: 'subagent-details' },
    role: 'sessionSubagentDetails',
} as const;
const composerSurfaceOne = {
    kind: 'composer',
    contribution: { pluginId: 'runtime.plugin', localId: 'composer-region' },
    immutableGenerationId: 'composer-generation-one',
    role: 'region',
} as const;
const automationSetupSurfaceOne = {
    kind: 'automationEventSetupSurface',
    contribution: { pluginId: 'runtime.plugin', localId: 'repository-updated' },
    immutableGenerationId: 'automation-generation-one',
} as const;
const destinationMount = (destination: typeof destinationOne | typeof destinationTwo) => ({
    kind: 'destination' as const,
    destination,
});
const digest = (character: string) => PluginUiArtifactDigestV1Schema.parse(
    `sha256:${character.repeat(64)}`,
);
const digestOne = digest('a');
const digestTwo = digest('b');

async function reconcileOne(params: Readonly<{
    store: ReturnType<typeof createReactNativeCrashStateStore>;
    destination?: typeof destinationOne;
    artifactDigest?: ReactNativeCrashStateBinding['artifactDigest'];
}>) {
    const destination = params.destination ?? destinationOne;
    const artifactDigest = params.artifactDigest ?? digestOne;
    const binding = { mount: destinationMount(destination), renderer, artifactDigest } satisfies ReactNativeCrashStateBinding;
    const reconciliation = await reconcileReactNativeCrashStateBindings({
        store: params.store,
        bindings: [binding],
    });
    const state = reconciliation.statesByBindingKey[createReactNativeCrashStateBindingKey(binding)];
    expect(state).toBeDefined();
    return state!;
}

describe('React Native crash-state daemon owner', () => {
    it('isolates Automation setup surfaces by exact immutable generation through the canonical mount key', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-automation-')),
        });
        const replacement = {
            ...automationSetupSurfaceOne,
            immutableGenerationId: 'automation-generation-two',
        } as const;
        const reconciliation = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: automationSetupSurfaceOne, renderer, artifactDigest: digestOne },
                { mount: replacement, renderer, artifactDigest: digestTwo },
            ],
        });
        const originalKey = createReactNativeCrashStateBindingKey({ mount: automationSetupSurfaceOne, renderer });
        const replacementKey = createReactNativeCrashStateBindingKey({ mount: replacement, renderer });

        expect(originalKey).not.toBe(replacementKey);
        expect(reconciliation.statesByBindingKey[originalKey]?.token.mount).toEqual(automationSetupSurfaceOne);
        expect(reconciliation.statesByBindingKey[replacementKey]?.token.mount).toEqual(replacement);
    });

    it('isolates an inline surface mount from destination and targeted surface mounts', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-inline-')),
        });
        const reconciliation = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: inlineSurfaceOne, renderer, artifactDigest: digestOne },
                { mount: targetedSurfaceOne, renderer, artifactDigest: digestOne },
            ],
        });

        const destinationKey = createReactNativeCrashStateBindingKey({
            mount: destinationMount(destinationOne),
            renderer,
        });
        const inlineKey = createReactNativeCrashStateBindingKey({ mount: inlineSurfaceOne, renderer });
        const targetedKey = createReactNativeCrashStateBindingKey({ mount: targetedSurfaceOne, renderer });

        expect(new Set([destinationKey, inlineKey, targetedKey])).toHaveLength(3);
        expect(reconciliation.statesByBindingKey[inlineKey]).toMatchObject({
            disabled: false,
            token: { mount: inlineSurfaceOne },
        });
    });

    it('does not read the unshipped V2 acknowledgement state snapshot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-v2-'));
        const oldStatePath = join(
            createReactNativeCrashStateStore({ happyHomeDir }).paths.stateDir,
            'react-native-crash-state.v2.json',
        );
        const store = createReactNativeCrashStateStore({ happyHomeDir });

        await store.update((current) => current);
        await writeFile(oldStatePath, JSON.stringify({
            t: 'happier_plugin_react_native_crash_state_v2',
            schemaVersion: 2,
            records: {
                legacy: {
                    token: {
                        mount: destinationMount(destinationOne),
                        renderer,
                        artifactDigest: digestOne,
                        crashStateEpoch: 0,
                    },
                    renderFailureCount: 1,
                    startupFailureCount: 2,
                    disabled: true,
                    failureOccurrences: {
                        '6f46c82c-9516-4e7e-8de8-531152228a01': 'startup_ack_timeout',
                    },
                },
            },
        }));

        expect(store.stateFilePath).toContain('react-native-crash-state.v3.json');
        expect(await createReactNativeCrashStateStore({ happyHomeDir }).read()).toEqual({
            t: 'happier_plugin_react_native_crash_state_v3',
            schemaVersion: 3,
            records: {},
        });
    });

    it('rejoins a lost daemon receipt exactly once', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-rejoin-')),
        });
        const { token } = await reconcileOne({ store });
        const occurrenceId = '6f46c82c-9516-4e7e-8de8-531152228a01';

        expect((await recordReactNativeCrashFailure({
            store,
            token,
            failureOccurrenceId: occurrenceId,
            failure: 'render_error',
        })).status).toBe('recorded');
        expect((await recordReactNativeCrashFailure({
            store,
            token,
            failureOccurrenceId: occurrenceId,
            failure: 'render_error',
        })).status).toBe('rejoined');
        const key = createReactNativeCrashStateBindingKey(token);
        expect((await store.read()).records[key]).toMatchObject({
            renderFailureCount: 1,
            disabled: false,
            failureOccurrences: { [occurrenceId]: 'render_error' },
        });
    });

    it('counts concurrent distinct current-epoch occurrences, then makes same-digest recovery explicit', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-reset-')),
        });
        const { token } = await reconcileOne({ store });

        const results = await Promise.all([
            recordReactNativeCrashFailure({
                store,
                token,
                failureOccurrenceId: '11111111-1111-4111-8111-111111111111',
                failure: 'render_error',
            }),
            recordReactNativeCrashFailure({
                store,
                token,
                failureOccurrenceId: '22222222-2222-4222-8222-222222222222',
                failure: 'render_error',
            }),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual(['recorded', 'recorded']);
        const key = createReactNativeCrashStateBindingKey(token);
        expect((await store.read()).records[key]).toMatchObject({
            renderFailureCount: 2,
            disabled: true,
            failureOccurrences: {
                '11111111-1111-4111-8111-111111111111': 'render_error',
                '22222222-2222-4222-8222-222222222222': 'render_error',
            },
        });

        expect((await recordReactNativeCrashFailure({
            store,
            token,
            failureOccurrenceId: '33333333-3333-4333-8333-333333333333',
            failure: 'render_error',
        })).status).toBe('ignored_disabled');
        expect(Object.keys((await store.read()).records[key]!.failureOccurrences)).toHaveLength(2);

        const reset = await resetReactNativeCrashState({ store, token });
        expect(reset.status).toBe('reset');
        expect(reset.token).toEqual({ ...token, crashStateEpoch: token.crashStateEpoch + 1 });
        expect((await store.read()).records[key]).toMatchObject({
            token: reset.token,
            renderFailureCount: 0,
            disabled: false,
            failureOccurrences: {},
        });
        expect((await recordReactNativeCrashFailure({
            store,
            token,
            failureOccurrenceId: '44444444-4444-4444-8444-444444444444',
            failure: 'render_error',
        })).status).toBe('binding_token_mismatch');
    });

    it('isolates destinations sharing one renderer and restores only the binding with a replacement digest', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-digest-')),
        });
        const initial = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: destinationMount(destinationTwo), renderer, artifactDigest: digestOne },
            ],
        });
        const firstToken = initial.statesByBindingKey[createReactNativeCrashStateBindingKey({
            mount: destinationMount(destinationOne),
            renderer,
        })]!.token;
        const secondToken = initial.statesByBindingKey[createReactNativeCrashStateBindingKey({
            mount: destinationMount(destinationTwo),
            renderer,
        })]!.token;

        await recordReactNativeCrashFailure({
            store,
            token: firstToken,
            failureOccurrenceId: '55555555-5555-4555-8555-555555555555',
            failure: 'render_error',
        });
        await recordReactNativeCrashFailure({
            store,
            token: firstToken,
            failureOccurrenceId: '66666666-6666-4666-8666-666666666666',
            failure: 'render_error',
        });

        expect((await store.read()).records[createReactNativeCrashStateBindingKey(secondToken)]).toMatchObject({
            disabled: false,
            renderFailureCount: 0,
        });

        const replacement = await reconcileOne({ store, artifactDigest: digestTwo });
        expect(replacement).toEqual({
            token: { ...firstToken, artifactDigest: digestTwo, crashStateEpoch: firstToken.crashStateEpoch + 1 },
            disabled: false,
        });
        expect((await recordReactNativeCrashFailure({
            store,
            token: firstToken,
            failureOccurrenceId: '77777777-7777-4777-8777-777777777777',
            failure: 'render_error',
        })).status).toBe('binding_token_mismatch');
    });

    it('isolates an exact targeted surface mount from a destination and gives a new target generation its own durable slot', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-targeted-')),
        });
        const reconciliation = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: targetedSurfaceOne, renderer, artifactDigest: digestOne },
            ],
        });
        const targetedKey = createReactNativeCrashStateBindingKey({ mount: targetedSurfaceOne, renderer });
        const destinationKey = createReactNativeCrashStateBindingKey({
            mount: destinationMount(destinationOne),
            renderer,
        });
        const targetedToken = reconciliation.statesByBindingKey[targetedKey]!.token;

        await recordReactNativeCrashFailure({
            store,
            token: targetedToken,
            failureOccurrenceId: '88888888-8888-4888-8888-888888888888',
            failure: 'render_error',
        });
        expect((await store.read()).records[destinationKey]).toMatchObject({
            renderFailureCount: 0,
            disabled: false,
        });

        const replacementMount = {
            ...targetedSurfaceOne,
            target: {
                ...targetedSurfaceOne.target,
                immutableGenerationId: 'target-generation-two',
            },
        } as const;
        const replacement = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: replacementMount, renderer, artifactDigest: digestOne },
            ],
        });
        const replacementKey = createReactNativeCrashStateBindingKey({ mount: replacementMount, renderer });
        expect(replacementKey).not.toBe(targetedKey);
        // The canonical Protocol mount key includes every immutable generation,
        // so a target-generation change owns a NEW durable slot: clean counts,
        // not disabled, epoch 0. It never inherits the predecessor's failures.
        expect(replacement.statesByBindingKey[replacementKey]).toMatchObject({
            token: { mount: replacementMount, crashStateEpoch: 0 },
            disabled: false,
        });
        expect((await store.read()).records[destinationKey]).toMatchObject({
            renderFailureCount: 0,
            disabled: false,
        });

        // The predecessor slot keeps its exact durable evidence, and its exact
        // token still fences only that historical record — never the new slot.
        await expect(recordReactNativeCrashFailure({
            store,
            token: targetedToken,
            failureOccurrenceId: '99999999-9999-4999-8999-999999999999',
            failure: 'render_error',
        })).resolves.toMatchObject({ status: 'recorded' });
        expect((await store.read()).records[targetedKey]).toMatchObject({
            renderFailureCount: 2,
            disabled: true,
        });
        expect((await store.read()).records[replacementKey]).toMatchObject({
            renderFailureCount: 0,
            disabled: false,
        });
    });

    it('isolates a Composer mount and gives a new Composer generation its own durable slot', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-composer-')),
        });
        const initial = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: composerSurfaceOne, renderer, artifactDigest: digestOne },
            ],
        });
        const composerKey = createReactNativeCrashStateBindingKey({ mount: composerSurfaceOne, renderer });
        const composerToken = initial.statesByBindingKey[composerKey]!.token;

        await recordReactNativeCrashFailure({
            store,
            token: composerToken,
            failureOccurrenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            failure: 'render_error',
        });

        const replacementMount = {
            ...composerSurfaceOne,
            immutableGenerationId: 'composer-generation-two',
        } as const;
        const replacement = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: replacementMount, renderer, artifactDigest: digestOne },
            ],
        });
        const replacementKey = createReactNativeCrashStateBindingKey({ mount: replacementMount, renderer });
        expect(replacementKey).not.toBe(composerKey);
        // Generation-exact durable slots: the new Composer generation starts
        // clean (epoch 0, no failures), while the predecessor slot keeps its
        // own evidence and its exact token fences only that historical slot.
        expect(replacement.statesByBindingKey[replacementKey]).toMatchObject({
            token: { mount: replacementMount, crashStateEpoch: 0 },
            disabled: false,
        });
        await expect(recordReactNativeCrashFailure({
            store,
            token: composerToken,
            failureOccurrenceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            failure: 'render_error',
        })).resolves.toMatchObject({ status: 'recorded' });
        expect((await store.read()).records[composerKey]).toMatchObject({
            renderFailureCount: 2,
            disabled: true,
        });
        expect((await store.read()).records[replacementKey]).toMatchObject({
            renderFailureCount: 0,
            disabled: false,
        });
    });

    it('accepts current tokens and fails closed for stale destination, targeted, and Composer persisted bindings', async () => {
        const store = createReactNativeCrashStateStore({
            happyHomeDir: await mkdtemp(join(tmpdir(), 'happier-rn-crash-state-currentness-')),
        });
        const reconciliation = await reconcileReactNativeCrashStateBindings({
            store,
            bindings: [
                { mount: destinationMount(destinationOne), renderer, artifactDigest: digestOne },
                { mount: targetedSurfaceOne, renderer, artifactDigest: digestOne },
                { mount: composerSurfaceOne, renderer, artifactDigest: digestOne },
            ],
        });
        const destinationToken = reconciliation.statesByBindingKey[
            createReactNativeCrashStateBindingKey({ mount: destinationMount(destinationOne), renderer })
        ]!.token;
        const targetedToken = reconciliation.statesByBindingKey[
            createReactNativeCrashStateBindingKey({ mount: targetedSurfaceOne, renderer })
        ]!.token;
        const composerToken = reconciliation.statesByBindingKey[
            createReactNativeCrashStateBindingKey({ mount: composerSurfaceOne, renderer })
        ]!.token;
        if (targetedToken.mount.kind !== 'targetedSurface' || composerToken.mount.kind !== 'composer') {
            throw new Error('Expected targeted and Composer crash bindings');
        }

        const cases = [
            {
                current: destinationToken,
                stale: { ...destinationToken, artifactDigest: digestTwo },
                currentOccurrenceId: '10101010-1010-4010-8010-101010101010',
                staleOccurrenceId: '20202020-2020-4020-8020-202020202020',
            },
            {
                current: targetedToken,
                stale: {
                    ...targetedToken,
                    mount: {
                        ...targetedToken.mount,
                        target: {
                            ...targetedToken.mount.target,
                            immutableGenerationId: 'target-generation-stale',
                        },
                    },
                },
                currentOccurrenceId: '30303030-3030-4030-8030-303030303030',
                staleOccurrenceId: '40404040-4040-4040-8040-404040404040',
            },
            {
                current: composerToken,
                stale: {
                    ...composerToken,
                    mount: {
                        ...composerToken.mount,
                        immutableGenerationId: 'composer-generation-stale',
                    },
                },
                currentOccurrenceId: '50505050-5050-4050-8050-505050505050',
                staleOccurrenceId: '60606060-6060-4060-8060-606060606060',
            },
        ] as const;

        for (const currentness of cases) {
            await expect(recordReactNativeCrashFailure({
                store,
                token: currentness.current,
                failureOccurrenceId: currentness.currentOccurrenceId,
                failure: 'render_error',
            })).resolves.toMatchObject({ status: 'recorded' });
            await expect(recordReactNativeCrashFailure({
                store,
                token: currentness.stale,
                failureOccurrenceId: currentness.staleOccurrenceId,
                failure: 'render_error',
            })).resolves.toMatchObject({ status: 'binding_token_mismatch' });
        }
    });
});
