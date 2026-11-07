import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/components/ui/lists/collection/CoreCollectionScope', () => ({ CoreCollectionScope: (props: { children: React.ReactNode }) => props.children }));

const { Directory } = await import('./StoreKindPage');
const { EmptyState } = await import('@/components/ui/empty/EmptyState');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

const idle = { loading: false, hasNextPage: false };
const render = (list: object, query = '') => renderScreen(<Directory kind="bot" rows={[]} groups={[]} list={{ ...idle, ...list }}
    query={query} sourceTitle={null} />);

afterEach(standardCleanup);

describe('Store directory states', () => {
    it('gives an empty directory the standard page state, with what belongs here', async () => {
        const screen = await render({});
        const state = screen.findAllByType(EmptyState)[0]!;
        expect(state.props.layout).toBe('page');
        expect(state.props.scene).toBeTruthy();
        expect(state.props.subtitle).toBeTruthy();
    });

    it('says every catalog failing as the page state, not a line above an empty page', async () => {
        const screen = await render({ sourceFailures: [
            { sourceId: 'a', message: 'A failed', onRetry: () => {} }, { sourceId: 'b', message: 'B failed', onRetry: () => {} },
        ] });
        expect(screen.findByTestId('store.kind.bot.empty')).toBeFalsy();
        expect(screen.findAllByType(SurfaceStateCard)[0]!.props.size).toBe('page');
    });

    it('keeps the inline no-match state for a real search', async () => {
        const screen = await render({}, 'garden');
        expect(screen.findAllByType(EmptyState)[0]!.props.layout).toBe('inline');
    });
});
