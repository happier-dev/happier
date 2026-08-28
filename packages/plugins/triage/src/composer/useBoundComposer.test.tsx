// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { Text, defineUiSurface, useComposer, type ComposerRefV1 } from '@happier-dev/plugin-ui';
import { afterEach, describe, expect, it } from 'vitest';

import { useTriageBoundComposer } from './useBoundComposer.js';

/**
 * The exact-ref binding (`core/COMPOSER.md` §3).
 *
 * The hook exists so a renderer writes the draft the host stamped on its mount
 * and no other. That guarantee is about every COMMITTED frame, not just the
 * settled one: a frame that pairs the replacement scope with the previous
 * scope's handle is a frame in which Attach writes the wrong message, and
 * "attaching to the wrong draft is discovered only after sending" is precisely
 * the failure the exact ref exists to prevent.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPOSER_A = Object.freeze({ kind: 'session', sessionId: 'session-a' }) as ComposerRefV1;
const COMPOSER_B = Object.freeze({ kind: 'session', sessionId: 'session-b' }) as ComposerRefV1;

function sessionIdOf(ref: ComposerRefV1): string {
    return (ref as unknown as Readonly<{ sessionId?: string }>).sessionId ?? '<none>';
}

/** Every committed render, as the pair the invariant is about. */
type CommittedFrame = Readonly<{
    mountedOn: string;
    wrote: string | null;
    current: string | null;
}>;

const mounted: PluginUiTestkit[] = [];

async function mountBinding(): Promise<Readonly<{
    frames: readonly CommittedFrame[];
    rebind: (next: ComposerRefV1) => Promise<void>;
}>> {
    const frames: CommittedFrame[] = [];
    let setComposer: ((next: ComposerRefV1) => void) | null = null;

    function Harness(): React.ReactElement {
        const [composer, setState] = React.useState<ComposerRefV1>(COMPOSER_A);
        setComposer = setState;
        const current = useComposer().current();
        const handle = useTriageBoundComposer(composer);
        frames.push(Object.freeze({
            mountedOn: sessionIdOf(composer),
            wrote: handle === null ? null : sessionIdOf(handle.ref),
            current: current === null ? null : sessionIdOf(current.ref),
        }));
        return <Text value="bound" variant="label" />;
    }

    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-bound-composer',
                generation: 'binding',
            },
            surface: defineUiSurface(Harness),
            surfaceContext: createSurfaceContextFixture({}),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        }) as PluginUiTestkit;
    });
    mounted.push(fixture);
    // Binding is a microtask behind the mount.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    return {
        frames,
        rebind: async (next: ComposerRefV1) => {
            await act(async () => { setComposer?.(next); });
            await act(async () => { await Promise.resolve(); });
            await act(async () => { await Promise.resolve(); });
        },
    };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('useTriageBoundComposer', () => {
    it('binds the exact scope outside a Composer-bound mount while current remains null', async () => {
        const binding = await mountBinding();

        expect(binding.frames.at(-1)).toEqual({
            mountedOn: 'session-a',
            wrote: 'session-a',
            current: null,
        });
    });

    it('never hands the previous scope handle to a replacement scope', async () => {
        const binding = await mountBinding();

        await binding.rebind(COMPOSER_B);

        // The effect that rebinds cannot run until after the render carrying
        // the replacement ref has committed, so a handle held as bare state
        // addresses the PREVIOUS draft for that frame.
        expect(binding.frames.filter((frame) => (
            frame.wrote !== null && frame.wrote !== frame.mountedOn
        ))).toEqual([]);
        expect(binding.frames.at(-1)).toEqual({
            mountedOn: 'session-b',
            wrote: 'session-b',
            current: null,
        });
    });
});
