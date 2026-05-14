import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerCustomThemeSpy = vi.fn();

vi.mock('@pierre/diffs', () => ({
    registerCustomTheme: (...args: any[]) => registerCustomThemeSpy(...args),
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

async function importFreshRegistry() {
    vi.resetModules();
    registerCustomThemeSpy.mockClear();
    return await import('./pierreThemeRegistry.web');
}

describe('Pierre dynamic theme registry', () => {
    beforeEach(() => {
        registerCustomThemeSpy.mockClear();
    });

    it('uses dynamic ids for effective custom theme colors', async () => {
        const registry = await importFreshRegistry();
        expect(typeof (registry as { ensureHappierPierreThemeRegistered?: unknown }).ensureHappierPierreThemeRegistered).toBe('function');
        expect(typeof (registry as { resolveHappierPierreThemeIds?: unknown }).resolveHappierPierreThemeIds).toBe('function');
        const { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } = registry as {
            ensureHappierPierreThemeRegistered: (params: Readonly<{ isDark: boolean; colors: Record<string, unknown> }>) => void;
            resolveHappierPierreThemeIds: (params: Readonly<{ isDark: boolean; colors: Record<string, unknown> }>) => Readonly<{ light: string; dark: string }>;
        };
        const colors = makeColors('#123456');

        const ids = resolveHappierPierreThemeIds({ isDark: false, colors });
        ensureHappierPierreThemeRegistered({ isDark: false, colors });

        expect(ids.light).toMatch(/^happier-light-/);
        expect(ids.light).not.toBe('happier-light');
        expect(ids.dark).toBe('happier-dark');
        expect(registerCustomThemeSpy).toHaveBeenCalledWith(ids.light, expect.any(Function));
    });

    it('does not leave later colors stuck on the first registered static id', async () => {
        const registry = await importFreshRegistry();
        expect(typeof (registry as { ensureHappierPierreThemeRegistered?: unknown }).ensureHappierPierreThemeRegistered).toBe('function');
        expect(typeof (registry as { resolveHappierPierreThemeIds?: unknown }).resolveHappierPierreThemeIds).toBe('function');
        const { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } = registry as {
            ensureHappierPierreThemeRegistered: (params: Readonly<{ isDark: boolean; colors: Record<string, unknown> }>) => void;
            resolveHappierPierreThemeIds: (params: Readonly<{ isDark: boolean; colors: Record<string, unknown> }>) => Readonly<{ light: string; dark: string }>;
        };
        const first = resolveHappierPierreThemeIds({ isDark: false, colors: makeColors('#123456') });
        const second = resolveHappierPierreThemeIds({ isDark: false, colors: makeColors('#abcdef') });

        ensureHappierPierreThemeRegistered({ isDark: false, colors: makeColors('#123456') });
        ensureHappierPierreThemeRegistered({ isDark: false, colors: makeColors('#abcdef') });

        expect(first.light).not.toBe(second.light);
        expect(registerCustomThemeSpy).toHaveBeenCalledWith(first.light, expect.any(Function));
        expect(registerCustomThemeSpy).toHaveBeenCalledWith(second.light, expect.any(Function));
    });
});
