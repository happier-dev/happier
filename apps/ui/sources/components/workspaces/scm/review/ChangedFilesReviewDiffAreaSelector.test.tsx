/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChangedFilesReviewDiffAreaSelector } from './ChangedFilesReviewDiffAreaSelector';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView }, View, Text, ScrollView };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme = { colors: { border: { default: '#ddd' }, surface: { inset: '#eee', base: '#fff' }, text: { primary: '#111' } } };

it('chooses a diff area from one menu and retains trailing actions for a single area', async () => {
    // jsdom has no layout; only the browser geometry boundary is supplied.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 32));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const labels = { pending: 'Pending', included: 'Included', both: 'Combined' };
    try {
        await act(async () => root.render(<ChangedFilesReviewDiffAreaSelector theme={theme} diffArea="both" availableModes={['included', 'pending', 'both']} labels={labels} onChange={onChange} />));
        const trigger = container.querySelector<HTMLElement>('[data-testid="scm-review-diff-area-menu"]');
        expect(trigger).not.toBeNull();
        expect(document.querySelector('[data-testid="scm-review-diff-area-pending"]')).toBeNull();
        await act(async () => trigger?.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="scm-review-diff-area-pending"]')).not.toBeNull());
        await act(async () => {
            const item = document.querySelector<HTMLElement>('[data-testid="scm-review-diff-area-pending"]');
            item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            item?.click();
        });
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('pending'));
        expect(onChange).toHaveBeenCalledTimes(1);
        await act(async () => root.render(<ChangedFilesReviewDiffAreaSelector theme={theme} diffArea="pending" availableModes={['pending']} labels={labels} onChange={onChange} trailingElement={<span data-testid="trailing">Action</span>} />));
        expect(container.querySelector('[data-testid="trailing"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="scm-review-diff-area-menu"]')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    }
});
