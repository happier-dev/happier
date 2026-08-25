// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { Text, defineUiSurface, type ComposerRefV1 } from '@happier-dev/plugin-ui';
import { afterEach, describe, expect, it } from 'vitest';

import {
    TriageEvidenceDisclosureProvider,
    useTriageEvidenceDisclosure,
    type TriageEvidenceCandidateV1,
    type TriageEvidenceDisclosureOutcomeV1,
    type TriageEvidenceDisclosureResolverV1,
} from '@happier-dev/triage-sources/ui';

import { useTriageTierBEvidenceInsertion } from './tierBEvidenceInsertion.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPOSER_A = Object.freeze({ kind: 'session', sessionId: 'session-a' }) as ComposerRefV1;
const REFERENCE = Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry-evidence' });
const CANDIDATE: TriageEvidenceCandidateV1 = Object.freeze({
    reference: REFERENCE,
    candidate: Object.freeze({ id: 'event-42', label: 'Sentry event 42' }),
});

type ApplyCall = Readonly<{ ref: unknown; transaction: unknown }>;
type Insertion = ReturnType<typeof useTriageTierBEvidenceInsertion>;

const mounted: PluginUiTestkit[] = [];

function deferredCandidate(): Readonly<{
    resolver: TriageEvidenceDisclosureResolverV1;
    resolve: (candidate: TriageEvidenceCandidateV1 | null) => void;
}> {
    let settle!: (candidate: TriageEvidenceCandidateV1 | null) => void;
    const promise = new Promise<TriageEvidenceCandidateV1 | null>((resolve) => {
        settle = resolve;
    });
    return { resolver: async () => await promise, resolve: settle };
}

async function mountInsertion(): Promise<Readonly<{
    fixture: PluginUiTestkit;
    applyCalls: readonly ApplyCall[];
    readRefs: readonly unknown[];
    insertion: () => Insertion;
    unmountConsumer: () => Promise<void>;
}>> {
    const applyCalls: ApplyCall[] = [];
    const readRefs: unknown[] = [];
    let currentInsertion: Insertion | null = null;
    let setVisible: ((visible: boolean) => void) | null = null;

    function Harness(): React.ReactElement {
        currentInsertion = useTriageTierBEvidenceInsertion(COMPOSER_A);
        return <Text value="Tier-B insertion harness" variant="label" />;
    }

    function Surface(): React.ReactElement {
        const [visible, setVisibleState] = React.useState(true);
        setVisible = setVisibleState;
        return visible ? <Harness /> : <Text value="Detail closed" variant="label" />;
    }

    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-tier-b-insertion',
                generation: 'tier-b-insertion',
            },
            surface: defineUiSurface(Surface),
            surfaceContext: createSurfaceContextFixture({}),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                readComposer: ({ ref }: Readonly<{ ref: unknown }>) => {
                    readRefs.push(ref);
                    return {
                        status: 'ready',
                        snapshot: {
                            revision: 9,
                            ref,
                            text: 'Investigate ',
                            selection: { start: 12, end: 12 },
                            references: [],
                            attachments: [],
                            layout: 'wrap',
                            capabilities: { text: true, references: true, attachments: true, submit: true },
                            state: {
                                focused: false,
                                editable: true,
                                submittable: true,
                                submitting: false,
                                running: false,
                            },
                        },
                    } as never;
                },
                applyComposer: ({ ref, transaction }: Readonly<{ ref: unknown; transaction: unknown }>) => {
                    applyCalls.push({ ref, transaction });
                    return { status: 'applied', revision: 10 } as never;
                },
            },
        }) as PluginUiTestkit;
    });
    mounted.push(fixture);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    return {
        fixture,
        applyCalls,
        readRefs,
        insertion: () => {
            if (currentInsertion === null) throw new Error('Insertion hook did not mount.');
            return currentInsertion;
        },
        unmountConsumer: async () => {
            await act(async () => { setVisible?.(false); });
        },
    };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('useTriageTierBEvidenceInsertion', () => {
    it('inserts through the exact origin Composer with one revision-checked text/reference transaction', async () => {
        const mountedInsertion = await mountInsertion();
        let outcome: Awaited<ReturnType<Insertion['disclose']>> | undefined;

        await act(async () => {
            outcome = await mountedInsertion.insertion().disclose(async () => CANDIDATE);
        });

        expect(outcome).toEqual({ kind: 'applied' });
        expect(mountedInsertion.readRefs).toEqual([COMPOSER_A]);
        expect(mountedInsertion.applyCalls).toHaveLength(1);
        expect(mountedInsertion.applyCalls[0]?.ref).toEqual(COMPOSER_A);
        expect(mountedInsertion.applyCalls[0]?.transaction).toEqual({
            expectedRevision: 9,
            operations: [
                { kind: 'text.insert', position: { offset: 12 }, text: 'Sentry event 42' },
                {
                    kind: 'reference.insert',
                    reference: {
                        kind: 'happier.composerReference',
                        ref: 'composerReference:event-42',
                        token: 'Sentry event 42',
                        start: 12,
                        end: 27,
                        label: 'Sentry event 42',
                        composerReference: REFERENCE,
                    },
                },
            ],
        });
    });

    it('makes a candidate that resolves after unmount inert and mutates no draft', async () => {
        const mountedInsertion = await mountInsertion();
        const delayed = deferredCandidate();
        let outcome: Awaited<ReturnType<Insertion['disclose']>> | undefined;

        await act(async () => {
            void mountedInsertion.insertion().disclose(delayed.resolver).then((next) => {
                outcome = next;
            });
            await Promise.resolve();
        });

        // Only the detail consumer leaves. The page and its Composer host stay
        // live, so a missing hook cleanup really would reach read/apply; a
        // stale-surface refusal cannot make this test pass on the host's behalf.
        await mountedInsertion.unmountConsumer();
        await act(async () => {
            delayed.resolve(CANDIDATE);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(outcome).toEqual({ kind: 'inert' });
        expect(mountedInsertion.readRefs).toEqual([]);
        expect(mountedInsertion.applyCalls).toEqual([]);
    });

    it('is what a mounted source detail reaches, and the source is handed no composer', async () => {
        // The composition the detail region mounts: this hook's value IS the
        // shared source bridge's contract, so a source detail nested under it
        // reaches the exact origin draft through the parent and never learns the
        // address. A bridge value the parent built its own adapter for could
        // drift from what the parent actually applies; there is no adapter.
        const applyCalls: ApplyCall[] = [];
        let disclosed: TriageEvidenceDisclosureOutcomeV1 | null = null;
        let handedKeys: readonly string[] = [];

        function SourceDetail(): React.ReactElement {
            const disclosure = useTriageEvidenceDisclosure();
            handedKeys = Object.keys(disclosure).sort();
            return (
                <Text
                    value={disclosure.available ? 'source detail' : 'source detail without a draft'}
                    variant="label"
                />
            );
        }

        let disclose: ((
            resolve: TriageEvidenceDisclosureResolverV1,
        ) => Promise<TriageEvidenceDisclosureOutcomeV1>) | null = null;

        function Surface(): React.ReactElement {
            const insertion = useTriageTierBEvidenceInsertion(COMPOSER_A);
            disclose = insertion.disclose;
            return (
                <TriageEvidenceDisclosureProvider disclosure={insertion}>
                    <SourceDetail />
                </TriageEvidenceDisclosureProvider>
            );
        }

        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: {
                    pluginId: 'happier.triage',
                    pluginVersion: '0.0.0',
                    viewId: 'triage-tier-b-bridge',
                    generation: 'tier-b-bridge',
                },
                surface: defineUiSurface(Surface),
                surfaceContext: createSurfaceContextFixture({}),
                adapter: createPluginUiRnwSemanticSurfaceAdapter(),
                handlers: {
                    readComposer: ({ ref }: Readonly<{ ref: unknown }>) => ({
                        status: 'ready',
                        snapshot: {
                            revision: 4,
                            ref,
                            text: 'Investigate ',
                            selection: { start: 12, end: 12 },
                            references: [],
                            attachments: [],
                            layout: 'wrap',
                            capabilities: { text: true, references: true, attachments: true, submit: true },
                            state: {
                                focused: false,
                                editable: true,
                                submittable: true,
                                submitting: false,
                                running: false,
                            },
                        },
                    }) as never,
                    applyComposer: ({ ref, transaction }: Readonly<{ ref: unknown; transaction: unknown }>) => {
                        applyCalls.push({ ref, transaction });
                        return { status: 'applied', revision: 5 } as never;
                    },
                },
            }) as PluginUiTestkit;
        });
        mounted.push(fixture);
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        await act(async () => {
            disclosed = (await disclose?.(async () => CANDIDATE)) ?? null;
        });

        expect(handedKeys).toEqual(['available', 'disclose']);
        expect(disclosed).toEqual({ kind: 'applied' });
        expect(applyCalls).toHaveLength(1);
        expect(applyCalls[0]?.ref).toEqual(COMPOSER_A);
        expect(applyCalls[0]?.transaction).toMatchObject({ expectedRevision: 4 });
    });
});
