import { beforeEach, describe, expect, it, vi } from 'vitest';

const codeToTokensSpy = vi.fn((_code: string, options: any) => ({
    fg: '#111111',
    tokens: [[{ content: String(options.theme), color: '#222222' }]],
}));

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: codeToTokensSpy,
}));

vi.mock('shiki', () => ({
    bundledLanguages: { javascript: {}, js: {}, text: {}, typescript: {}, ts: {} },
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

function makeColors(keyword: string) {
    return {
        surface: { base: '#ffffff', inset: '#f6f8fa' },
        text: { primary: '#24292f', secondary: '#57606a' },
        syntax: {
            default: '#24292f',
            keyword,
            string: '#0a3069',
            comment: '#6e7781',
            number: '#0550ae',
            function: '#8250df',
        },
    };
}

function makeHighlighter() {
    return {
        loadLanguage: async () => {},
        codeToTokens: codeToTokensSpy,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolver) => {
        resolve = resolver;
    });
    return { promise, resolve };
}

async function importFreshModule() {
    vi.resetModules();
    createHighlighterSpy.mockClear();
    return await import('./shikiTokenize.web');
}

describe('shikiTokenizeLines dynamic theme cache', () => {
    beforeEach(() => {
        createHighlighterSpy.mockClear();
        codeToTokensSpy.mockClear();
    });

    it('uses effective syntax colors in the registered Shiki theme key', async () => {
        const { shikiTokenizeLines } = await importFreshModule();

        await shikiTokenizeLines({
            isDark: false,
            language: 'typescript',
            lines: ['const value = 1;'],
            colors: makeColors('#123456'),
        });

        const registeredTheme = createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0];
        expect(registeredTheme?.name).toMatch(/^happier-light-/);
        expect(registeredTheme?.name).not.toBe('happier-light');
        expect(registeredTheme?.tokenColors).toEqual(expect.arrayContaining([
            expect.objectContaining({
                scope: expect.arrayContaining(['keyword']),
                settings: expect.objectContaining({ foreground: '#123456' }),
            }),
        ]));
    });

    it('partitions highlighter cache by effective theme key and language', async () => {
        const { shikiTokenizeLines } = await importFreshModule();
        const colors = makeColors('#123456');

        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 1;'], colors });
        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 2;'], colors });
        await shikiTokenizeLines({ isDark: false, language: 'javascript', lines: ['const value = 3;'], colors });
        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 4;'], colors: makeColors('#abcdef') });

        expect(createHighlighterSpy).toHaveBeenCalledTimes(3);
        const themeNames = createHighlighterSpy.mock.calls.map((call) => call[0]?.themes?.[0]?.name);
        expect(new Set(themeNames).size).toBe(2);
    });

    it('reuses tokenization results for identical theme, language, and content', async () => {
        const { shikiTokenizeLines } = await importFreshModule();
        const colors = makeColors('#123456');

        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 1;'], colors });
        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 1;'], colors });
        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 2;'], colors });

        expect(createHighlighterSpy).toHaveBeenCalledTimes(1);
        expect(codeToTokensSpy).toHaveBeenCalledTimes(2);
    });

    it('evicts least recently used dynamic highlighters beyond the cache cap', async () => {
        const { shikiTokenizeLines } = await importFreshModule();
        const firstColors = makeColors('#100000');

        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 0;'], colors: firstColors });
        for (let i = 1; i <= 8; i++) {
            const keyword = `#${(0x100000 + i).toString(16).padStart(6, '0')}`;
            // eslint-disable-next-line no-await-in-loop
            await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: [`const value = ${i};`], colors: makeColors(keyword) });
        }
        await shikiTokenizeLines({ isDark: false, language: 'typescript', lines: ['const value = 9;'], colors: firstColors });

        expect(createHighlighterSpy).toHaveBeenCalledTimes(10);
    });

    it('does not cache an in-flight highlighter after its key is cleared', async () => {
        const deferred = createDeferred<ReturnType<typeof makeHighlighter>>();
        createHighlighterSpy.mockImplementationOnce(async () => await deferred.promise);
        const module = await importFreshModule();
        const {
            resolveHappierShikiThemeId,
            shikiTokenizeLines,
        } = module;
        expect(typeof (module as { clearShikiCacheForKey?: unknown }).clearShikiCacheForKey).toBe('function');
        const clearShikiCacheForKey = (module as { clearShikiCacheForKey: (key: string) => void }).clearShikiCacheForKey;
        const colors = makeColors('#445566');
        const oldKey = resolveHappierShikiThemeId({ isDark: false, colors });

        const firstTokenize = shikiTokenizeLines({
            isDark: false,
            language: 'typescript',
            lines: ['const value = 1;'],
            colors,
        });
        clearShikiCacheForKey(oldKey);
        deferred.resolve(makeHighlighter());
        await firstTokenize;

        await shikiTokenizeLines({
            isDark: false,
            language: 'typescript',
            lines: ['const value = 2;'],
            colors,
        });

        expect(createHighlighterSpy).toHaveBeenCalledTimes(2);
    });
});
