// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComposerRefV1 } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTriageEntryDetailLaunchInput } from '../../composer/entryDetailLaunchInput.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { useTriageRetainedComposerOriginV1 } from './retainedComposerOrigin.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPOSER = Object.freeze({ kind: 'session', sessionId: 'session-a' }) as ComposerRefV1;
const LAUNCHED = testkitEntryRef({ entryId: '17' });
const OTHER = testkitEntryRef({ entryId: '18' });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
});

type Props = Readonly<{
    launch: ReturnType<typeof buildTriageEntryDetailLaunchInput> | undefined;
    selectedEntryRef: TriageEntryRefV1 | null;
}>;

function render(initial: Props): Readonly<{
    origin: () => ComposerRefV1 | null;
    update: (next: Props) => Promise<void>;
}> {
    let current: ComposerRefV1 | null = null;

    function Harness(props: Props): React.ReactElement {
        current = useTriageRetainedComposerOriginV1(props);
        return <span>{current === null ? 'none' : 'bound'}</span>;
    }

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => { root?.render(<Harness {...initial} />); });

    return {
        origin: () => current,
        update: async (next) => { await act(async () => { root?.render(<Harness {...next} />); }); },
    };
}

describe('useTriageRetainedComposerOriginV1', () => {
    it('still answers for the launched entry after the host retires the launch', async () => {
        // The deciding case. The host retires a delivered launch the moment the
        // page's own location moves, which is the same moment the launch is
        // adopted — so an address read straight off the prop is absent for the
        // entire life of the detail it opened.
        const harness = render({
            launch: buildTriageEntryDetailLaunchInput({
                entryRef: LAUNCHED,
                sourceInstance: { source: LAUNCHED.source, sourceInstanceId: 'instance-a' },
                originComposer: COMPOSER,
            }),
            selectedEntryRef: LAUNCHED,
        });
        expect(harness.origin()).toEqual(COMPOSER);

        await harness.update({ launch: undefined, selectedEntryRef: LAUNCHED });

        expect(harness.origin()).toEqual(COMPOSER);
    });

    it('answers for no other entry than the one the composer opened', async () => {
        const harness = render({
            launch: buildTriageEntryDetailLaunchInput({
                entryRef: LAUNCHED,
                sourceInstance: { source: LAUNCHED.source, sourceInstanceId: 'instance-a' },
                originComposer: COMPOSER,
            }),
            selectedEntryRef: LAUNCHED,
        });
        expect(harness.origin()).toEqual(COMPOSER);

        await harness.update({ launch: undefined, selectedEntryRef: OTHER });

        expect(harness.origin()).toBeNull();
    });

    it('holds nothing for an app-origin open', async () => {
        const harness = render({
            launch: buildTriageEntryDetailLaunchInput({
                entryRef: LAUNCHED,
                sourceInstance: { source: LAUNCHED.source, sourceInstanceId: 'instance-a' },
            }),
            selectedEntryRef: LAUNCHED,
        });

        expect(harness.origin()).toBeNull();
    });
});
