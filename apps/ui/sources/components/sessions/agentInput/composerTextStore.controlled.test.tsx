import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useComposerTextSource, useComposerTextValue, type ComposerTextSource } from './composerTextStore';

afterEach(standardCleanup);

it('publishes controlled text to its memoized input leaf in the parent commit', async () => {
    let commits = 0;
    let setText: React.Dispatch<React.SetStateAction<string>> | undefined;
    const Leaf = React.memo(function Leaf({ source }: { source: ComposerTextSource }) {
        return React.createElement('ComposerText', { value: useComposerTextValue(source) });
    });
    function Controlled() {
        const [text, update] = React.useState('Initial prompt');
        setText = update;
        const source = useComposerTextSource(text);
        return <React.Profiler id="controlled-text" onRender={() => { commits += 1; }}>
            <Leaf source={source} />
        </React.Profiler>;
    }
    const screen = await renderScreen(<Controlled />);
    commits = 0;
    await act(async () => { setText!('Edited prompt'); });
    expect(screen.root.findByType('ComposerText').props.value).toBe('Edited prompt');
    expect(commits).toBe(1);
});
