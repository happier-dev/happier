/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ReviewBar } from './ReviewBar';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const textOf = (node: { props: { children?: unknown } }) => [node.props.children].flat().join('');

describe('ReviewBar (phone review, lab rvp)', () => {
    it('P4: offline keeps Discard in place, disabled with its reason, and Keep working', async () => {
        const keep = vi.fn();
        const screen = await renderScreen(<ReviewBar current={2} total={3} onPrevious={() => {}} onNext={() => {}}
            onKeep={keep} onDiscard={() => {}} discardDisabledReason="Discard needs NLDW3" />);
        const discard = screen.tree.findByProps({ testID: 'review-bar-discard' });
        expect(discard.props).toMatchObject({ disabled: true, accessibilityHint: 'Discard needs NLDW3' });
        expect(screen.tree.findByProps({ testID: 'review-bar-keep' }).props.disabled).toBe(false);
        await screen.pressByTestIdAsync('review-bar-keep');
        expect(keep).toHaveBeenCalledTimes(1);
        // An added-file hunk offers no Discard at all; omission is distinct from disabled-with-reason.
        await screen.update(<ReviewBar current={2} total={3} onKeep={keep} />);
        expect(screen.tree.findAllByProps({ testID: 'review-bar-discard' })).toHaveLength(0);
        expect(screen.tree.findByProps({ testID: 'review-bar-keep' }).props.disabled).toBe(false);
    });
    it('P2: the completion names the file Next file opens', async () => {
        const next = vi.fn();
        const screen = await renderScreen(<ReviewBar current={0} total={1} complete={{ nextFileName: 'stageNotes.ts', onNextFile: next }} />);
        expect(textOf(screen.tree.findByProps({ testID: 'review-bar-next-file-name' }))).toContain('stageNotes.ts');
        await screen.pressByTestIdAsync('review-bar-next-file');
        expect(next).toHaveBeenCalledTimes(1);
        const done = await renderScreen(<ReviewBar current={0} total={1} complete={{ nextFileName: null }} />);
        expect(done.tree.findAllByProps({ testID: 'review-bar-next-file' })).toHaveLength(0);
        expect(done.tree.findAllByProps({ testID: 'review-bar-next-file-name' })).toHaveLength(0);
    });
});
