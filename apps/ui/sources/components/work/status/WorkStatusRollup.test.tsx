import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

const needsYou = { state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: null, word: 'Needs permission', glyph: 'review' } as const;

describe('WorkStatusRollup', () => {
    it('says how many folded rows need the person, and stays silent when the group cannot know', async () => {
        const { WorkStatusRollup } = await import('./WorkStatusRollup');
        const several = await renderScreen(<WorkStatusRollup testID="rollup" rollup={{ status: needsYou, needsYouCount: 3, coverage: 'complete' }} />);
        expect(several.getTextContent()).toContain(t('sessionWork.strip.needsYou', { count: 3 }));
        standardCleanup();
        const one = await renderScreen(<WorkStatusRollup testID="rollup" rollup={{ status: needsYou, needsYouCount: 1, coverage: 'complete' }} />);
        // One request is the glyph alone; its word is spoken.
        expect(one.getTextContent()).not.toContain(t('sessionWork.strip.needsYou', { count: 1 }));
        expect(one.findHostByTestId('rollup')?.props.accessibilityLabel).toBe('Needs permission');
        standardCleanup();
        const unknown = await renderScreen(<WorkStatusRollup testID="rollup" rollup={{ status: needsYou, needsYouCount: null, coverage: 'unavailable' }} />);
        expect(unknown.findHostByTestId('rollup')).toBeNull();
    });
});
