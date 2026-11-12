import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { Directory, kindPageWaitsForCuration } = await import('./StoreKindPage');
const { EmptyState } = await import('@/components/ui/empty/EmptyState');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

const idle = { loading: false, hasNextPage: false };
const render = (list: object, query = '') => renderScreen(<Directory kind="bot" rows={[]} groups={[]} list={{ ...idle, ...list }}
    query={query} sourceTitle={null} />);

afterEach(standardCleanup);

describe('Store directory states', () => {
    it('waits for curated positions only while they arrive: a failed cold curation never hides the kind\'s own rows (J03)', () => {
        const cold = { hasValue: false, loading: false };
        expect(kindPageWaitsForCuration({ browsing: true, kind: 'app', curationRead: { ...cold, loading: true } })).toBe(true);
        expect(kindPageWaitsForCuration({ browsing: true, kind: 'app', curationRead: cold })).toBe(false);
        expect(kindPageWaitsForCuration({ browsing: true, kind: 'agent', curationRead: cold })).toBe(false);
        expect(kindPageWaitsForCuration({ browsing: false, kind: 'app', curationRead: { ...cold, loading: true } })).toBe(false);
        // Retrying a settled failure keeps the shown rows instead of flashing back to loading.
        expect(kindPageWaitsForCuration({ browsing: true, kind: 'app', curationRead: { ...cold, loading: true }, settled: true })).toBe(false);
    });

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
        // "Couldn't reach {catalog}" on the line; what each source said waits behind Details.
        expect(outage.props.failures.map((failure: { message: string }) => failure.message))
            .toEqual(['promptLibrary.registriesStatus.unreachableSource(source=Happier catalog)',
                'promptLibrary.registriesStatus.unreachableSource(source=Team catalog)']);
        expect(outage.props.failures.map((failure: { details: readonly string[] }) => failure.details[0])).toEqual(['A failed', 'B failed']);
    });

    it('says an outage above the results, so rows arriving under it never move it', async () => {
        const row = { key: 'a', title: 'Alpha', description: null, mark: null, group: 'g', open: () => {} };
        const screen = await renderScreen(<Directory kind="bot" rows={[row]} groups={[{ key: 'g', title: 'Group' }]} query="" sourceTitle={() => 'Team catalog'}
            list={{ ...idle, sourceFailures: [{ sourceId: 'a', message: 'A failed', onRetry: () => {} }] }} />);
        const { RegistrySourcesUnavailable } = await import('@/components/capabilities/add/RegistrySourcesUnavailable');
        const { Collection } = await import('@happier-dev/plugin-ui');
        const order = screen.tree.findAll(node => node.type === RegistrySourcesUnavailable || node.type === Collection)
            .map(node => node.type === Collection ? 'results' : 'outage');
        expect(order).toEqual(['outage', 'results']);
    });

    it('keeps each source reason beside its own technical code when details open', async () => {
        const { RegistrySourcesUnavailable } = await import('@/components/capabilities/add/RegistrySourcesUnavailable');
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(<RegistrySourcesUnavailable testID="catalog.failures" failures={[
            { key: 'first', message: 'Curated catalog unavailable', details: ['Technical code: unreachable'], onRetry: () => {} },
            { key: 'second', message: 'Chrome Web Store needs a Machine', details: ['Technical code: needs_machine'], onRetry: () => {} },
        ]} />);
        await act(async () => { screen.findAllByType(SurfaceStateCard)[0]!.props.secondaryAction.onPress(); });
        const details = screen.findByTestId('catalog.failures.sources')!;
        expect(details.findAllByType(Text).map(node => node.props.children)).toEqual([
            'Curated catalog unavailable', 'Technical code: unreachable',
            'Chrome Web Store needs a Machine', 'Technical code: needs_machine',
        ]);
    });

    it('keeps the inline no-match state for a real search', async () => {
        const screen = await render({}, 'garden');
        expect(screen.findAllByType(EmptyState)[0]!.props.layout).toBe('inline');
    });
});
