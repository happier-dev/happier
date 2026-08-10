import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { FrozenSubtree } from './FrozenSubtree';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeHandle = Readonly<{
    renders: () => number;
    log: readonly string[];
    setValue: (value: number) => void;
}>;

function createProbe() {
    const log: string[] = [];
    let renders = 0;
    let setValue: ((value: number) => void) | null = null;

    const Probe = () => {
        renders += 1;
        const [value, setStateValue] = React.useState(0);
        setValue = setStateValue;
        React.useEffect(() => {
            log.push('passive:mount');
            return () => log.push('passive:cleanup');
        }, []);
        React.useLayoutEffect(() => {
            log.push('layout:mount');
            return () => log.push('layout:cleanup');
        }, []);
        return <probe value={value} />;
    };

    const handle: ProbeHandle = {
        renders: () => renders,
        log,
        setValue: (value: number) => setValue?.(value),
    };
    return { Probe, handle };
}

function readProbeValue(renderer: ReactTestRenderer): number | null {
    const json = renderer.toJSON() as { props?: { value?: number } } | null;
    return json?.props?.value ?? null;
}

describe('FrozenSubtree', () => {
    it('stops rendering while frozen and resumes with the latest state, not a stale or empty one', async () => {
        const { Probe, handle } = createProbe();
        let renderer!: ReactTestRenderer;

        await act(async () => {
            renderer = create(<FrozenSubtree frozen={false}><Probe /></FrozenSubtree>);
        });
        await act(async () => { handle.setValue(1); });
        expect(readProbeValue(renderer)).toBe(1);
        const rendersBeforeFreeze = handle.renders();

        await act(async () => { renderer.update(<FrozenSubtree frozen={true}><Probe /></FrozenSubtree>); });
        await act(async () => { handle.setValue(2); });
        await act(async () => { handle.setValue(3); });
        expect(handle.renders()).toBe(rendersBeforeFreeze);

        await act(async () => { renderer.update(<FrozenSubtree frozen={false}><Probe /></FrozenSubtree>); });
        expect(handle.renders()).toBe(rendersBeforeFreeze + 1);
        expect(readProbeValue(renderer)).toBe(3);
    });

    it('tears down layout effects while frozen and re-runs them on thaw', async () => {
        const { Probe, handle } = createProbe();
        let renderer!: ReactTestRenderer;

        await act(async () => {
            renderer = create(<FrozenSubtree frozen={false}><Probe /></FrozenSubtree>);
        });
        expect(handle.log).toContain('layout:mount');

        await act(async () => { renderer.update(<FrozenSubtree frozen={true}><Probe /></FrozenSubtree>); });
        expect(handle.log.filter((entry) => entry === 'layout:cleanup')).toHaveLength(1);

        await act(async () => { renderer.update(<FrozenSubtree frozen={false}><Probe /></FrozenSubtree>); });
        expect(handle.log.filter((entry) => entry === 'layout:mount')).toHaveLength(2);
    });

    it('keeps passive effects alive while frozen, so a caller cannot use it to stop a poll', async () => {
        const { Probe, handle } = createProbe();
        let renderer!: ReactTestRenderer;

        await act(async () => {
            renderer = create(<FrozenSubtree frozen={false}><Probe /></FrozenSubtree>);
        });
        await act(async () => { renderer.update(<FrozenSubtree frozen={true}><Probe /></FrozenSubtree>); });

        // React 19.1 does not disconnect passive effects for a suspended subtree (only
        // `<Activity mode="hidden">` does, and it is not shipped here). Freezing removes render and
        // derivation cost; an interval or subscription registered in `useEffect` survives it.
        expect(handle.log).not.toContain('passive:cleanup');
        expect(handle.log.filter((entry) => entry === 'passive:mount')).toHaveLength(1);
    });
});
