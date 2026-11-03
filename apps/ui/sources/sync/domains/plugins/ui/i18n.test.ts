import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act, flushHookEffects, renderHook } from '@/dev/testkit';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from './projection';
import { resolvePluginProjectedActionPresentation } from './actionPresentation';
import {
    createPluginLocalizedTextResolver, createPluginUiTranslationRuntime, resolvePluginLocalizedText,
    resolvePluginUiTranslationBundle, usePluginLocalizedTextResolver, usePluginUiTranslationDemand, usePluginLocalizedText,
} from './i18n';

const pluginId = 'acme.review';
const keyed = { key: 'review.title', fallback: 'Author fallback' };
const bytes = (messages: Record<string, string>) => new TextEncoder().encode(JSON.stringify(messages));
function createProjection(ids: readonly string[] = [pluginId]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        translationsByPluginId: Object.fromEntries(ids.map(id => [id, {
            id: `translations:${id}`, pluginId: id, contributionKind: 'translations',
            locales: ['en', 'fr', 'de'], resourceIdsByLocale: { en: 'copy.en', fr: 'copy.fr', de: 'copy.de' },
        }])),
    };
}

describe('plugin translation Resource demand', () => {
    it('interpolates admitted label parameters after locale selection and in the author fallback without acquiring copy', () => {
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en', 'fr'],
                bundles: { en: { 'review.continue': 'Continue {count} more · {pullRequest}' },
                    fr: { 'review.continue': '{pullRequest} : encore {count}' } } },
        } };
        const resolve = createPluginLocalizedTextResolver({ projection, locale: 'fr' });
        const label = { key: 'review.continue', fallback: 'Continue {count} more · {pullRequest}',
            params: { count: 7, pullRequest: 'example/repository#1' } };
        expect(resolve(pluginId, label)).toBe('example/repository#1 : encore 7');
        expect(resolve(pluginId, { ...label, key: 'review.missing' })).toBe('Continue 7 more · example/repository#1');
        expect(resolve(pluginId, { key: 'review.missing', fallback: '{zero} {value}',
            params: { zero: 0, value: '{zero}' } })).toBe('0 {zero}');
        expect(resolve(pluginId, 'Literal {count}')).toBe('Literal {count}');
        expect(resolve(pluginId, { ...label, params: { count: { unsafe: 'value' } } }))
            .toBe(label.fallback);
        expect(resolve(pluginId, { ...label, params: { count: 7 } })).toBe(label.fallback);
        const staleCatalog = createPluginLocalizedTextResolver({ projection: {
            ...projection, translationsByPluginId: { [pluginId]: {
                ...projection.translationsByPluginId[pluginId]!,
                bundles: { fr: { 'review.continue': 'Ancien libellé' } },
            } },
        }, locale: 'fr' });
        expect(staleCatalog(pluginId, label)).toBe('Continue 7 more · example/repository#1');
        expect(resolvePluginProjectedActionPresentation({ pluginId, projection, locale: 'fr',
            presentation: { title: label, description: label },
        })).toMatchObject({ title: 'example/repository#1 : encore 7', description: 'example/repository#1 : encore 7' });
        expect(resolvePluginProjectedActionPresentation({ pluginId, projection, locale: 'fr',
            presentation: { title: '  Authored literal  ' },
        }).title).toBe('Authored literal');
    });

    it('publishes only changed copy across unavailable retries and recovery at 100-plugin scale', async () => {
        const ids = Array.from({ length: 100 }, (_, index) => `acme.retry${index}`);
        const projection = createProjection(ids);
        let available = false;
        let publications = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_source, id) =>
            available ? bytes({ 'review.title': id }) : null });
        const stop = runtime.subscribe(() => { publications++; });
        try {
            for (let attempt = 0; attempt < 4; attempt++) {
                await Promise.all(ids.map(id => runtime.demand(id, 'en')));
            }
            expect(publications).toBe(0);
            available = true;
            await Promise.all(ids.map(id => runtime.demand(id, 'en')));
            expect(publications).toBe(100);
            for (const id of ids) expect(runtime.getText(id, 'review.title', 'en')).toBe(id);
            await Promise.all(ids.map(id => runtime.demand(id, 'en')));
            expect(publications).toBe(100);
        } finally { stop(); runtime.dispose(); }
    });

    it('preserves inline preferred and English copy until every producer has migrated', async () => {
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            translationsByPluginId: {
                [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en', 'fr'],
                    bundles: { en: { 'review.title': 'Review', 'review.english': 'English', 'review.blank': 'English blank' }, fr: { 'review.title': 'Tableau', 'review.blank': '' } } },
            },
        };
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async () => { reads++; return null; } });
        const resolve = createPluginLocalizedTextResolver({ projection, locale: 'fr' });
        expect(resolve(pluginId, keyed)).toBe('Tableau');
        expect(resolve(pluginId, { key: 'review.english', fallback: 'Fallback' })).toBe('English');
        expect(resolve(pluginId, { key: 'review.blank', fallback: 'Blank fallback' })).toBe('Blank fallback');
        await runtime.demand(pluginId, 'fr');
        expect(createPluginLocalizedTextResolver({ projection, runtime, locale: 'fr' })(pluginId, keyed)).toBe('Tableau');
        expect(reads).toBe(0);
        const emptyRuntime = createPluginUiTranslationRuntime({ projection: EMPTY_PLUGIN_UI_PROJECTION, readResourceBytes: async () => null });
        expect(createPluginLocalizedTextResolver({ projection, runtime: emptyRuntime, locale: 'fr' })(pluginId, keyed)).toBe('Tableau');
        emptyRuntime.dispose();
        runtime.dispose();
    });

    it('reads inline keys without enumerating complete locale tables for each visible label', () => {
        let enumerations = 0;
        const messages = new Proxy(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`label.${index}`, `Label ${index}`])), {
            ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
        });
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en'], bundles: { en: messages } },
        } };
        const resolve = createPluginLocalizedTextResolver({ projection, locale: 'en' });
        for (let index = 0; index < 100; index++) expect(resolve(pluginId, { key: `label.${index}` })).toBe(`Label ${index}`);
        expect(enumerations).toBe(0);
    });

    it.each([
        { resourceIdsByLocale: { fr: 'copy.fr' }, expected: 'Resource French', english: 'Inline English', resource: 'copy.fr' },
        { resourceIdsByLocale: { en: 'copy.en' }, expected: 'Inline French', english: 'Resource English', resource: 'copy.en' },
    ])('preserves mixed per-locale inline and Resource producers: $resource', async ({ resourceIdsByLocale, expected, english, resource }) => {
        const base = createProjection();
        const projection: PluginUiProjectionModel = { ...base, translationsByPluginId: {
            [pluginId]: { ...base.translationsByPluginId[pluginId]!, resourceIdsByLocale,
                bundles: { en: { 'review.title': 'Inline English', 'review.english': 'Inline English' }, fr: { 'review.title': 'Inline French' } } },
        } };
        const reads: string[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_source, _id, resourceId) => {
            reads.push(resourceId);
            return bytes(resourceId === 'copy.fr' ? { 'review.title': 'Resource French' } : { 'review.english': 'Resource English' });
        } });
        await runtime.demand(pluginId, 'fr');
        const resolve = createPluginLocalizedTextResolver({ projection, runtime, locale: 'fr' });
        expect(resolve(pluginId, keyed)).toBe(expected);
        expect(resolve(pluginId, { key: 'review.english' })).toBe(english);
        expect(reads).toEqual([resource]);
        runtime.dispose();
    });

    it('never displays another admitted source’s Resource copy for the same plugin id', async () => {
        const projection = createProjection();
        const otherProjection = createProjection();
        const reads: PluginUiProjectionModel[] = [];
        const readers: Array<() => PluginUiProjectionModel | null> = [];
        const runtime = createPluginUiTranslationRuntime({ projection,
            readResourceBytes: async () => { throw new Error('The currentness-bound reader owns bytes'); },
            createResourceReader: current => {
                readers.push(current);
                return async source => {
                    expect(current()).toBe(source);
                    reads.push(source);
                    return bytes({ 'review.title': source === projection ? 'Root source' : 'Selected source' });
                };
            },
        });
        await runtime.demand(pluginId, 'en');
        expect(resolvePluginLocalizedText({ projection: otherProjection, runtime, pluginId, value: keyed, locale: 'en' })).toBe('Author fallback');
        const hook = await renderHook(() => {
            const resolve = usePluginLocalizedTextResolver({ projection: otherProjection, runtime, locale: 'en' });
            return resolve(pluginId, keyed);
        });
        expect(hook.getCurrent()).toBe('Selected source');
        expect(reads).toEqual([projection, otherProjection]);
        await hook.unmount();
        runtime.dispose();
        expect(readers.every(current => current() === null)).toBe(true);
    });

    it('binds imperative opening and synchronous labels to the same selected-source runtime', async () => {
        const projection = createProjection();
        const selected = createProjection();
        const reads: PluginUiProjectionModel[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async source => {
            reads.push(source);
            return bytes({ 'review.title': source === selected ? 'Selected title' : 'Root title' });
        } });
        const hook = await renderHook(() => usePluginLocalizedText({ projection: selected, runtime, locale: 'en' }));
        expect(reads).toEqual([]);
        await act(async () => { await hook.getCurrent().demandTranslations([pluginId]); });
        expect(hook.getCurrent().localize(pluginId, keyed)).toBe('Selected title');
        expect(reads).toEqual([selected]);
        await hook.unmount();
        runtime.dispose();
    });

    it('reads only the visible plugin’s preferred and English Resources, sharing concurrent demand', async () => {
        const projection = createProjection(Array.from({ length: 100 }, (_, i) => i === 0 ? pluginId : `acme.plugin${i}`));
        const reads: string[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, id, resourceId) => {
            reads.push(`${id}:${resourceId}`);
            return bytes(resourceId === 'copy.fr'
                ? { 'review.title': 'Tableau', 'review.blank': '', 'review.whitespace': '   ' }
                : { 'review.title': 'Review', 'review.english': 'English', 'review.blank': 'English blank', 'review.whitespace': 'English whitespace' });
        } });
        expect(reads).toEqual([]);
        await Promise.all([runtime.demand(pluginId, 'fr'), runtime.demand(pluginId, 'fr')]);
        expect(reads.sort()).toEqual([`${pluginId}:copy.en`, `${pluginId}:copy.fr`]);
        const resolver = createPluginLocalizedTextResolver({ projection, runtime, locale: 'fr' });
        expect(resolver(pluginId, keyed)).toBe('Tableau');
        expect(resolver(pluginId, { key: 'review.english', fallback: 'Fallback' })).toBe('English');
        expect(resolver(pluginId, { key: 'review.blank', fallback: 'Blank fallback' })).toBe('Blank fallback');
        expect(resolver(pluginId, { key: 'review.blank' })).toBe('review.blank');
        expect(resolver(pluginId, { key: 'review.whitespace', fallback: 'Whitespace fallback' })).toBe('Whitespace fallback');
        expect(resolver(pluginId, 'Author literal')).toBe('Author literal');
        expect(resolvePluginUiTranslationBundle({ projection, runtime, pluginId, locale: 'fr' }))
            .toEqual({ 'review.title': 'Tableau', 'review.english': 'English', 'review.blank': '', 'review.whitespace': '   ' });
        await runtime.demand(pluginId, 'fr');
        expect(reads).toHaveLength(2);
        runtime.dispose();
    });

    it('keeps committed copy while a new locale loads and refuses a superseded locale result', async () => {
        const projection = createProjection();
        let finishFrench!: (value: Uint8Array) => void;
        let finishGerman!: (value: Uint8Array) => void;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, _id, resourceId) => {
            if (resourceId === 'copy.fr') return new Promise(resolve => { finishFrench = resolve; });
            if (resourceId === 'copy.de') return new Promise(resolve => { finishGerman = resolve; });
            return bytes({ 'review.title': 'Review' });
        } });
        await runtime.demand(pluginId, 'en');
        const french = runtime.demand(pluginId, 'fr');
        expect(runtime.getBundle(pluginId, 'fr')).toEqual({ 'review.title': 'Review' });
        const german = runtime.demand(pluginId, 'de');
        finishGerman(bytes({ 'review.title': 'Prüfung' }));
        await german;
        finishFrench(bytes({ 'review.title': 'Tableau' }));
        await french;
        expect(runtime.getBundle(pluginId, 'de')).toEqual({ 'review.title': 'Prüfung' });
        runtime.dispose();
    });

    it('uses English, author literal or key for malformed, missing and failed Resource reads without retrying on render', async () => {
        const projection = createProjection(['acme.invalid', 'acme.missing', 'acme.failed']);
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, id, resourceId) => {
            reads++;
            if (id === 'acme.failed') throw new Error('Resource unavailable');
            if (id === 'acme.missing') return null;
            return resourceId === 'copy.en' ? bytes({ 'review.title': 'Review' }) : new TextEncoder().encode('{broken');
        } });
        await Promise.all(['acme.invalid', 'acme.missing', 'acme.failed'].map(id => runtime.demand(id, 'fr')));
        expect(resolvePluginLocalizedText({ projection, runtime, pluginId: 'acme.invalid', value: keyed, locale: 'fr' })).toBe('Review');
        expect(resolvePluginLocalizedText({ projection, runtime, pluginId: 'acme.missing', value: keyed, locale: 'fr' })).toBe('Author fallback');
        expect(resolvePluginLocalizedText({ projection, runtime, pluginId: 'acme.failed', value: { key: 'missing' }, locale: 'fr' })).toBe('missing');
        expect(resolvePluginLocalizedText({ projection, runtime, pluginId: 'acme.missing', value: { key: 'toString' }, locale: 'fr' })).toBe('toString');
        // Render-driven demand shares the failed settlement; only a new
        // explicit opening/retry may acquire unavailable bytes again.
        await runtime.demand('acme.failed', 'fr', { retryUnavailable: false });
        expect(reads).toBe(6);
        runtime.dispose();
    });

    it('retries only unavailable locale bytes on explicit demand while visible rerenders stay idle', async () => {
        const projection = createProjection();
        const reads: string[] = [];
        let available = false;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, _id, resourceId) => {
            reads.push(resourceId);
            if (resourceId === 'copy.en') return bytes({ 'review.title': 'Review', 'review.english': 'English' });
            return available ? bytes({ 'review.title': 'Tableau' }) : null;
        } });
        let publications = 0;
        const stop = runtime.subscribe(() => { publications++; });
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            const resolve = usePluginLocalizedTextResolver({ projection, runtime, locale: 'fr' });
            return resolve(pluginId, keyed);
        });
        try {
            expect(hook.getCurrent()).toBe('Review');
            expect(reads).toEqual(['copy.en', 'copy.fr']);
            expect(publications).toBe(1);
            const admittedBundle = runtime.getBundle(pluginId, 'fr');
            const settledRenders = renders;
            // Retrying unavailable bytes must settle without publishing the
            // same English fallback back into the mounted React subscriber.
            await act(async () => { await runtime.demand(pluginId, 'fr'); });
            expect(runtime.getBundle(pluginId, 'fr')).toBe(admittedBundle);
            expect(publications).toBe(1);
            expect(renders).toBe(settledRenders);
            available = true;
            await hook.rerender();
            expect(hook.getCurrent()).toBe('Review');
            expect(reads).toEqual(['copy.en', 'copy.fr', 'copy.fr']);
            await act(async () => { await runtime.demand(pluginId, 'fr'); });
            expect(hook.getCurrent()).toBe('Tableau');
            expect(publications).toBe(2);
            expect(runtime.getText(pluginId, 'review.english', 'fr')).toBe('English');
            await hook.rerender();
            expect(reads).toEqual(['copy.en', 'copy.fr', 'copy.fr', 'copy.fr']);
            expect(publications).toBe(2);
        } finally { stop(); await hook.unmount(); runtime.dispose(); }
    });

    it('aborts retired projection reads and never publishes their late copy', async () => {
        const projection = createProjection();
        let finish!: (value: Uint8Array) => void;
        const signals: AbortSignal[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, _id, _resourceId, signal) => {
            signals.push(signal);
            return new Promise(resolve => { finish = resolve; });
        } });
        const pending = runtime.demand(pluginId, 'en');
        runtime.setProjection(EMPTY_PLUGIN_UI_PROJECTION);
        expect(signals.every(signal => signal.aborted)).toBe(true);
        finish(bytes({ 'review.title': 'Retired' }));
        await pending;
        expect(runtime.getBundle(pluginId, 'en')).toEqual({});
        runtime.dispose();
    });

    it('includes only mounted contributors, preserving target precedence', async () => {
        const projection = createProjection([pluginId, 'acme.source', 'acme.unadmitted']);
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, id) => (
            bytes(id === pluginId ? { 'review.title': 'Target' } : { 'review.title': 'Contributor', 'source.title': id })
        ) });
        await Promise.all([runtime.demand(pluginId, 'en'), runtime.demand('acme.source', 'en')]);
        expect(resolvePluginUiTranslationBundle({ projection, runtime, pluginId, locale: 'en', contributorPluginIds: ['acme.source', 'acme.source'] }))
            .toEqual({ 'review.title': 'Target', 'source.title': 'acme.source' });
        runtime.dispose();
    });

    it('hydrates visible keyed hook consumers while literals and unrelated plugins add no demand or rerender', async () => {
        const projection = createProjection([pluginId, 'acme.other']);
        let finish!: (value: Uint8Array) => void;
        const reads: string[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_projection, id) => {
            reads.push(id);
            if (id === pluginId) return new Promise(resolve => { finish = resolve; });
            return bytes({ 'review.title': 'Other' });
        } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            const resolve = usePluginLocalizedTextResolver({ projection, runtime, locale: 'en' });
            resolve('acme.other', 'Author literal');
            return resolve(pluginId, keyed);
        });
        expect(hook.getCurrent()).toBe('Author fallback');
        expect(reads).toEqual([pluginId]);
        await act(async () => { finish(bytes({ 'review.title': 'Loaded review' })); });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe('Loaded review');
        const settledRenders = renders;
        await act(async () => { await runtime.demand('acme.other', 'en'); });
        expect(renders).toBe(settledRenders);
        await hook.unmount();
        runtime.dispose();
    });

    it('reacquires copy when the admitted source changes under a mounted consumer', async () => {
        const projection = createProjection();
        const replacement = createProjection();
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async source => {
            reads++;
            return bytes({ 'review.title': source === projection ? 'First source' : 'Replacement source' });
        } });
        const hook = await renderHook(({ projection: current }: { projection: PluginUiProjectionModel }) => {
            React.useLayoutEffect(() => { runtime.setProjection(current); }, [current]);
            const resolve = usePluginLocalizedTextResolver({ projection: current, runtime, locale: 'en' });
            return resolve(pluginId, keyed);
        }, { initialProps: { projection } });
        expect(hook.getCurrent()).toBe('First source');
        await hook.rerender({ projection: replacement });
        expect(hook.getCurrent()).toBe('Replacement source');
        expect(reads).toBe(2);
        await hook.unmount();
        runtime.dispose();
    });

    it('does not read Resources for a render that never commits', async () => {
        const projection = createProjection();
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async () => {
            reads++;
            return bytes({ 'review.title': 'Not visible' });
        } });
        const suspended = new Promise<never>(() => {});
        const hook = await renderHook(() => {
            const resolve = usePluginLocalizedTextResolver({ projection, runtime, locale: 'en' });
            resolve(pluginId, keyed);
            throw suspended;
        }, { wrapper: ({ children }) => React.createElement(React.Suspense, { fallback: null }, children) });
        expect(reads).toBe(0);
        await hook.unmount();
        runtime.dispose();
    });

    it('defers imperative copy reads until a real opening event', async () => {
        const projection = createProjection();
        let reads = 0;
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async () => {
            reads++;
            return bytes({ 'review.title': 'Opened title' });
        } });
        const hook = await renderHook(() => ({
            demand: usePluginUiTranslationDemand({ runtime, locale: 'en' }),
            resolve: usePluginLocalizedTextResolver({ projection, runtime, locale: 'en' }),
        }));
        expect(reads).toBe(0);
        await act(async () => { await hook.getCurrent().demand([pluginId]); });
        expect(hook.getCurrent().resolve(pluginId, keyed)).toBe('Opened title');
        expect(reads).toBe(1);
        await hook.unmount();
        runtime.dispose();
    });

    it('retains active copy across unrelated projection changes and reads future locales from the current projection', async () => {
        const projection = createProjection();
        const refreshed = { ...projection };
        const sources: PluginUiProjectionModel[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async source => {
            sources.push(source);
            return bytes({ 'review.title': 'Current title' });
        } });
        await runtime.demand(pluginId, 'en');
        const bundle = runtime.getBundle(pluginId, 'en');
        runtime.setProjection(refreshed);
        await runtime.demand(pluginId, 'en');
        expect(runtime.getBundle(pluginId, 'en')).toBe(bundle);
        expect(sources).toHaveLength(1);
        await runtime.demand(pluginId, 'fr');
        expect(sources[1]).toBe(refreshed);
        runtime.dispose();
    });
});
