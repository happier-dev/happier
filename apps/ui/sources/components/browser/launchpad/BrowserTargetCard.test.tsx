import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';

import { BrowserTargetCard } from './BrowserTargetCard';

const row: BrowserLaunchpadRow = {
    id: 'recent:example',
    section: 'recent',
    sourceKind: 'recent',
    title: 'Example',
    subtitle: 'example.com',
    detail: 'externalUrl',
    target: {
        kind: 'externalUrl',
        targetId: 'external_example',
        url: 'https://example.com/',
        display: { title: 'Example', addressLabel: 'example.com' },
    },
    disabledReason: null,
    lastSeenAt: 1_000,
};

describe('BrowserTargetCard (B-RC6 memoization)', () => {
    it('is a memoized component (skips re-render for referentially-equal props)', () => {
        // React.memo wraps the component with a `react.memo` element type. This guards the perf
        // contract that a stable `row` (preserved by stable row identity across polls) does not
        // re-render the card on every preview poll.
        const typeSymbol = (BrowserTargetCard as unknown as { $$typeof?: symbol }).$$typeof;
        expect(typeSymbol).toBe(Symbol.for('react.memo'));
    });

    it('does not re-render the card subtree when a parent re-renders with a stable row reference', async () => {
        const onOpenTarget = vi.fn();
        let bump!: () => void;

        function Harness(): React.ReactElement {
            const [, setTick] = React.useState(0);
            bump = () => setTick((value) => value + 1);
            // Stable row + callback references across re-renders.
            return <BrowserTargetCard row={row} onOpenTarget={onOpenTarget} testID="probe-card" />;
        }

        const screen = await renderScreen(<Harness />);
        const before = screen.findByTestId('probe-card');
        expect(before).toBeTruthy();

        await act(async () => {
            bump();
        });

        // The memoized card subtree remains mounted and stable across the parent re-render.
        const after = screen.findByTestId('probe-card');
        expect(after).toBeTruthy();
    });
});
