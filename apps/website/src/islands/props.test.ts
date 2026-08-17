import { describe, expect, it } from 'vitest';

import { deserialiseIslandProps, serialiseIslandProps } from './props';

/**
 * The trip these tests describe is: build-time `serialise` → HTML attribute →
 * browser `getAttribute` → `deserialise`. The middle two steps are the browser's
 * and cannot be run here, but they are a pure escape/unescape pair, so
 * round-tripping the ends is the whole contract.
 */
describe('island props', () => {
    it('omits the attribute entirely when an island has no props', () => {
        expect(serialiseIslandProps('nav')).toBeUndefined();
        expect(serialiseIslandProps('nav', {})).toBeUndefined();
    });

    it('round-trips the prop shapes an island is allowed to take', () => {
        const props = {
            variant: 'static',
            isHome: false,
            size: 18,
            missing: null,
            slugs: ['claude-code', 'codex'],
            nested: { justify: 'center', depth: 2 },
        };
        expect(deserialiseIslandProps('nav', serialiseIslandProps('nav', props) ?? null)).toEqual(props);
    });

    /**
     * The reason a data attribute was chosen over an inline
     * `<script type="application/json">`: this string terminates a script
     * element and nothing can be done about it there, whereas an attribute
     * carries it verbatim.
     */
    it('carries strings that would end a <script> block or look like a comment', () => {
        const props = { code: '</script><!-- --> & "quoted"   </SCRIPT >' };
        expect(deserialiseIslandProps('x', serialiseIslandProps('x', props) ?? null)).toEqual(props);
    });

    /**
     * `JSON.stringify` drops these silently, which would ship an island missing
     * a prop with no error anywhere. A build failure naming the prop is the only
     * outcome that gets fixed.
     */
    it('refuses props that cannot survive the trip, naming the prop', () => {
        expect(() => serialiseIslandProps('nav', { onClick: (() => {}) as never })).toThrow(/prop "onClick" is a function/);
        expect(() => serialiseIslandProps('nav', { at: new Date(0) as never })).toThrow(/prop "at" is a Date/);
        expect(() => serialiseIslandProps('nav', { n: 1n as never })).toThrow(/prop "n" is a bigint/);
    });

    it('treats a missing attribute as no props and a corrupted one as an error', () => {
        expect(deserialiseIslandProps('nav', null)).toEqual({});
        expect(deserialiseIslandProps('nav', '')).toEqual({});
        expect(() => deserialiseIslandProps('nav', '{"variant":')).toThrow(/not valid JSON/);
        expect(() => deserialiseIslandProps('nav', '["static"]')).toThrow(/parsed to an array/);
    });
});
