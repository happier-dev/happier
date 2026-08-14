import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { rich } from './rich';

const render = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('rich()', () => {
    const code = { 1: (c: React.ReactNode) => <code>{c}</code> };

    it('renders a message with no slots or values unchanged', () => {
        expect(render(rich('Plain sentence.'))).toBe('Plain sentence.');
    });

    it('substitutes named values', () => {
        expect(render(rich('Install {name} on your computer.', undefined, { name: 'Codex CLI' }))).toBe(
            'Install Codex CLI on your computer.',
        );
    });

    it('wraps a slot in its element', () => {
        expect(render(rich('Run <1>happier codex</1> in a repository.', code))).toBe(
            'Run <code>happier codex</code> in a repository.',
        );
    });

    it('substitutes a value INSIDE a slot', () => {
        expect(render(rich('Looks for <1>{binary}</1> on your PATH.', code, { binary: 'codex' }))).toBe(
            'Looks for <code>codex</code> on your PATH.',
        );
    });

    /**
     * The reason slots are named rather than positional. A translator must be
     * able to move the linked phrase to wherever the target language puts it,
     * and reorder it relative to other slots.
     */
    it('lets a translation reorder the slots', () => {
        const slots = {
            1: (c: React.ReactNode) => <a href="/a">{c}</a>,
            2: (c: React.ReactNode) => <b>{c}</b>,
        };
        expect(render(rich('<1>first</1> then <2>second</2>', slots))).toBe(
            '<a href="/a">first</a> then <b>second</b>',
        );
        expect(render(rich('<2>second</2> then <1>first</1>', slots))).toBe(
            '<b>second</b> then <a href="/a">first</a>',
        );
    });

    it('nests slots', () => {
        const slots = {
            1: (c: React.ReactNode) => <a href="/a">{c}</a>,
            2: (c: React.ReactNode) => <code>{c}</code>,
        };
        expect(render(rich('see <1>the <2>happier</2> docs</1>', slots))).toBe(
            'see <a href="/a">the <code>happier</code> docs</a>',
        );
    });

    /**
     * Failure modes are VISIBLE, never silent and never fatal. A marketing page
     * that renders `<2>` is findable in a screenshot; one that renders a blank
     * paragraph, or throws during SSR and fails the build for the whole site,
     * is neither.
     */
    it('renders an unknown slot as literal text rather than dropping it', () => {
        expect(render(rich('a <2>b</2> c', code))).toBe('a &lt;2&gt;b&lt;/2&gt; c');
    });

    it('renders an unknown value as its own placeholder', () => {
        expect(render(rich('Install {nope}.', undefined, { name: 'x' }))).toBe('Install {nope}.');
    });

    it('recovers from an unclosed slot instead of swallowing the sentence', () => {
        const out = render(rich('start <1>middle and the rest of it', code));
        expect(out).toContain('middle and the rest of it');
        expect(out).toContain('start');
    });

    it('escapes markup that arrives inside a value', () => {
        expect(render(rich('{x}', undefined, { x: '<script>alert(1)</script>' }))).toBe(
            '&lt;script&gt;alert(1)&lt;/script&gt;',
        );
    });
});
