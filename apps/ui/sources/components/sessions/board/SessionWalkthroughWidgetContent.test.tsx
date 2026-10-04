import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, SPECIMEN_ANALYSIS_COMPLETE } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { WalkthroughWidgetContentView } from './SessionWalkthroughWidgetContent';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const reading = (refs: string[] = []) => buildWalkthroughReading({
    comparison: SPECIMEN_COMPARISON, walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
    analysis: SPECIMEN_ANALYSIS_COMPLETE,
    reviewed: { v: 1, comparisonId: SPECIMEN_COMPARISON.id, reviewedChangeRefs: refs },
});

describe('Walkthrough Board reading projection', () => {
    it('distinguishes unknown marks from confirmed empty and updates the next stop with personal marks', async () => {
        const initial = reading();
        const screen = await renderScreen(<WalkthroughWidgetContentView reading={initial} marksLoaded={false} testID="walk" />);
        expect(screen.findByTestId('walk-progress')).toBeNull();
        expect(screen.getTextContent()).not.toContain('walkthrough.done');
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={initial} marksLoaded testID="walk" />); });
        expect(screen.findByTestId('walk-progress')?.props.children).toContain('"count":0');
        const marked = reading([...initial.stops[0]!.changeRefs]);
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={marked} marksLoaded testID="walk" />); });
        expect(screen.findByTestId('walk-progress')?.props.children).toContain('"count":1');
        expect(screen.findByTestId('walk-next')?.props.children).toContain(marked.stops[1]!.title);
    });
    it('opens the walkthrough only for an interactive placement and stays inert in a preview', async () => {
        const onOpen = vi.fn();
        const screen = await renderScreen(<WalkthroughWidgetContentView reading={reading()} marksLoaded onOpen={onOpen} testID="walk" />);
        await screen.pressByTestId('walk-open');
        expect(onOpen).toHaveBeenCalledOnce();
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={reading()} marksLoaded testID="walk" />); });
        expect(screen.findByTestId('walk-open')).toBeNull();
    });
});
