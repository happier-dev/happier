import { afterEach, describe, expect, it, vi } from 'vitest';
import parse from 'css-tree/lib/parser';

import { prepareThemeCss, prepareThemeProfileCss } from './prepareThemeCss';

// The third-party parser boundary delegates to the real parser while counting work.
vi.mock('css-tree/lib/parser', async (importOriginal) => {
    const actual = await importOriginal<typeof import('css-tree/lib/parser')>();
    return { default: vi.fn(actual.default) };
});
afterEach(() => vi.clearAllMocks());

describe('theme CSS native projection and coverage', () => {
    it('shares one lazy preparation between facts and application of the retained profile body', () => {
        const profile = { css: '[data-surface=composer]{padding:8px}' };
        const facts = prepareThemeProfileCss(profile);
        const application = prepareThemeProfileCss(profile);
        expect(parse).not.toHaveBeenCalled();
        expect(facts.coverage.native).toBe(1);
        expect(application.light.composer?.root?.base.paddingTop).toBe(8);
        expect(parse).toHaveBeenCalledTimes(1);
        expect(application).toBe(facts);
    });
    it('does no native parsing for source-only web application or empty projections', () => {
        const source = '[data-surface=composer]{padding:8px}';
        expect(prepareThemeCss(source).source).toBe(source);
        const empty = prepareThemeCss(' \n ');
        expect(empty.light).toEqual({});
        expect(empty.dark).toEqual({});
        expect(empty.coverage).toEqual({ total: 0, native: 0, webOnly: 0, affectedSurfaces: [], hides: [] });
        expect(empty.detailedCoverage.rules).toEqual([]);
        expect(parse).not.toHaveBeenCalled();
    });

    it('shares one lazy parse and stable projections across appearances, summary and detail', () => {
        const prepared = prepareThemeCss('[data-surface=composer]{padding:8px}');
        expect(parse).not.toHaveBeenCalled();
        const light = prepared.light;
        const dark = prepared.dark;
        const summary = prepared.coverage;
        const detail = prepared.detailedCoverage;
        expect(parse).toHaveBeenCalledTimes(1);
        expect(prepared.light).toBe(light);
        expect(prepared.dark).toBe(dark);
        expect(prepared.coverage).toBe(summary);
        expect(prepared.detailedCoverage).toBe(detail);
        expect(summary).not.toHaveProperty('rules');
        expect(detail.rules).toHaveLength(1);
    });

    it('resolves shorthand, important, specificity, source order and semantic states before rendering', () => {
        const prepared = prepareThemeCss(`
            [data-surface=session-row]{padding:8px 12px!important;opacity:.8;border-radius:4px 8px 12px 16px}
            [data-state=selected][data-surface=session-row]{padding-left:20px;opacity:.4}
            .dark [data-surface=session-row]{opacity:.6}
            :root:not(.dark) [data-surface=session-row]{opacity:.7}
            [data-surface=session-row][data-state=default]{border-width:4px}
            [data-surface=composer][data-part=toolbar]{margin:3px;display:none}
            [data-part=toolbar][data-surface=composer]{display:flex}
        `);
        expect(prepared.light['session-row']?.root?.base).toMatchObject({
            opacity: .7, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
            borderTopWidth: 4, borderTopLeftRadius: 4, borderTopRightRadius: 8,
            borderBottomRightRadius: 12, borderBottomLeftRadius: 16,
        });
        expect(prepared.light['session-row']?.root?.states.selected).toMatchObject({ paddingLeft: 12, opacity: .7 });
        expect(prepared.light['session-row']?.root?.states.selected).not.toHaveProperty('borderTopWidth');
        expect(prepared.dark['session-row']?.root?.base.opacity).toBe(.6);
        expect(prepared.light.composer?.toolbar?.base).toMatchObject({ marginTop: 3, display: 'flex' });
        expect(prepared.light.composer?.root).toBeUndefined();
        expect(prepared.coverage.hides).toEqual([]);
    });

    it('normalizes CSS property casing before conversion and cascade', () => {
        const prepared = prepareThemeCss('[data-surface=composer]{PADDING:8px;Padding-Left:3px;OPACITY:.5}');
        expect(prepared.light.composer?.root?.base).toMatchObject({ paddingTop: 8, paddingLeft: 3, opacity: .5 });
        expect(prepared.coverage).toMatchObject({ total: 1, native: 1, webOnly: 0 });
    });

    it('applies supported declarations from mixed rules but counts the whole rule web only', () => {
        const source = ':root{--accent:red}.dark{--accent:blue}[data-surface=composer]{padding:8px;backdrop-filter:blur(4px)}';
        const prepared = prepareThemeCss(source);
        expect(prepared.light.composer?.root?.base.paddingTop).toBe(8);
        expect(prepared.coverage).toMatchObject({ total: 1, native: 0, webOnly: 1,
            affectedSurfaces: [{ surface: 'composer', part: 'root' }] });
        expect(prepared.detailedCoverage.rules[0]?.reasons).toContainEqual(expect.objectContaining({
            kind: 'property', property: 'backdrop-filter',
        }));
    });

    it('rejects unsupported selector branches, conditional rules and unregistered addresses without leaking styles', () => {
        const prepared = prepareThemeCss(`
            .other,[data-surface=composer]{padding:99px}
            @media(min-width:10px){[data-surface=composer]{padding:88px}}
            [data-surface=composer][data-part=missing]{padding:77px}
            [data-surface=session-row][data-state=hover]{opacity:.2}
        `);
        expect(prepared.light).toEqual({});
        expect(prepared.coverage).toEqual({ total: 4, native: 0, webOnly: 4, affectedSurfaces: [], hides: [] });
        expect(prepared.detailedCoverage.rules[1]?.reasons).toContainEqual(expect.objectContaining({ kind: 'condition' }));
    });

    it('reports only final hidden states and appearances with their declaration range', () => {
        const source = '[data-surface=session-row]{display:none}[data-surface=session-row][data-state=selected]{display:flex}.dark [data-surface=user-bubble]{display:none}';
        const prepared = prepareThemeCss(source);
        expect(prepared.coverage.hides.map(({ address, mode }) => ({ address, mode }))).toEqual([
            { address: { surface: 'session-row', part: 'root', state: 'default' }, mode: 'both' },
            { address: { surface: 'user-bubble', part: 'root' }, mode: 'dark' },
        ]);
        for (const hide of prepared.coverage.hides) expect(source.slice(hide.range.start, hide.range.end)).toBe('display:none');
    });

    // PLAN.md native CSS parser/nesting ruling: unresolved blocks count once.
    it.each([
        '& [data-surface=composer]{padding:2px;& [data-part=toolbar]{opacity:.4}}',
        'a:hover{opacity:.5;b:focus{opacity:.3}}',
    ])('preserves one authored range for unresolved nesting: %s', (nested) => {
        const source = `[data-surface=session-row]{padding:1px;${nested}}[data-surface=user-bubble]{opacity:.7}`;
        const prepared = prepareThemeCss(source);
        expect(prepared.coverage).toMatchObject({ total: 3, native: 2, webOnly: 1 });
        expect(prepared.light['session-row']?.root?.base.paddingTop).toBe(1);
        expect(prepared.light['user-bubble']?.root?.base.opacity).toBe(.7);
        const entry = prepared.detailedCoverage.rules[1]!;
        expect(entry.native).toBe(false);
        expect(source.slice(entry.range.start, entry.range.end)).toBe(nested);
    });

    it('keeps syntax fragments on their parent rule without inventing qualified rules', () => {
        const source = '[data-surface=composer]{padding:1px;broken}';
        const prepared = prepareThemeCss(source);
        expect(prepared.coverage).toMatchObject({ total: 1, native: 0, webOnly: 1 });
        expect(prepared.light.composer?.root?.base.paddingTop).toBe(1);
        const reason = prepared.detailedCoverage.rules[0]?.reasons.find((item) => item.kind === 'syntax');
        expect(source.slice(reason!.range.start, reason!.range.end)).toBe('broken');
    });

    it('does not treat custom-property blocks or quoted braces as nested rules', () => {
        const prepared = prepareThemeCss('[data-surface=composer]{--x:{a:b};content:"{";padding:2px}');
        expect(prepared.coverage).toMatchObject({ total: 1, native: 0, webOnly: 1 });
        expect(prepared.light.composer?.root?.base.paddingTop).toBe(2);
    });

    it('screens resources before native conversion and retains authored removal diagnostics', () => {
        const source = '[data-surface=composer]{padding:2px;background:url(https://sentinel.invalid/a)}';
        const prepared = prepareThemeCss(source);
        expect(prepared.light.composer?.root?.base.paddingTop).toBe(2);
        expect(prepared.light.composer?.root?.base).not.toHaveProperty('backgroundColor');
        expect(prepared.coverage).toMatchObject({ total: 1, native: 0, webOnly: 1 });
        const removal = prepared.detailedCoverage.stripped[0]!;
        expect(source.slice(removal.range.start, removal.range.end)).toBe('background:url(https://sentinel.invalid/a)');
    });
});
