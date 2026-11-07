import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

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

    it('lets a section keep its own empty state instead of the page state', async () => {
        const screen = await renderScreen(<Directory kind="bot" rows={[]} groups={[]} list={idle} query="" sourceTitle={null}
            emptyState={<EmptyState testID="section.empty" layout="inline" title="Section empty" />} />);
        expect(screen.findByTestId('section.empty')).toBeTruthy();
        expect(screen.findByTestId('store.kind.bot.empty')).toBeFalsy();
    });

    it('says a section\'s catalog outage as a line inside it, naming each catalog', async () => {
        const screen = await renderScreen(<Directory kind="bot" rows={[]} groups={[]} query="" emptyState={null}
            sourceTitle={id => (id === 'a' ? 'Happier catalog' : 'Team catalog')}
            list={{ ...idle, sourceFailures: [
                { sourceId: 'a', message: 'A failed', onRetry: () => {} }, { sourceId: 'b', message: 'B failed', onRetry: () => {} },
            ] }} />);
        const { RegistrySourcesUnavailable } = await import('@/components/capabilities/add/RegistrySourcesUnavailable');
        const outage = screen.findAllByType(RegistrySourcesUnavailable)[0]!;
        expect(outage.props.size).toBe('line');
        expect(outage.props.failures.map((failure: { message: string }) => failure.message))
            .toEqual(['Happier catalog · A failed', 'Team catalog · B failed']);
    });

    it('keeps the inline no-match state for a real search', async () => {
        const screen = await render({}, 'garden');
        expect(screen.findAllByType(EmptyState)[0]!.props.layout).toBe('inline');
    });
});
