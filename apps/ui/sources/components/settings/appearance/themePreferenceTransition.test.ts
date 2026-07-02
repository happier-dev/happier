import { describe, expect, it, vi } from 'vitest';

import {
    registerNativeThemePreferenceTransitionController,
    runThemePreferenceChange,
    shouldAnimateThemePreferenceChange,
} from './themePreferenceTransition';

describe('theme preference transitions', () => {
    it('does not animate when adaptive resolves to the current visual theme', () => {
        expect(
            shouldAnimateThemePreferenceChange({
                currentPreference: 'light',
                nextPreference: 'adaptive',
                platform: 'web',
                reduceMotion: false,
                systemTheme: 'light',
            }),
        ).toBe(false);
    });

    it('allows same-visual-mode theme profile activation to force an animation', () => {
        const input = {
            currentPreference: 'light' as const,
            nextPreference: 'light' as const,
            platform: 'web' as const,
            reduceMotion: false,
            systemTheme: 'light' as const,
            forceAnimate: true,
        };

        expect(shouldAnimateThemePreferenceChange(input)).toBe(true);
    });

    it('keeps reduced motion authoritative over forced animation', () => {
        const input = {
            currentPreference: 'light' as const,
            nextPreference: 'dark' as const,
            platform: 'web' as const,
            reduceMotion: true,
            systemTheme: 'light' as const,
            forceAnimate: true,
        };

        expect(shouldAnimateThemePreferenceChange(input)).toBe(false);
    });

    it('animates web theme changes with a top-to-bottom view transition reveal', async () => {
        const mutation = vi.fn();
        const animate = vi.fn();
        const startViewTransition = vi.fn((update: () => void) => {
            update();
            return { ready: Promise.resolve() };
        });
        const documentLike = {
            documentElement: { animate },
            startViewTransition,
        } as unknown as Document;

        await runThemePreferenceChange({
            currentPreference: 'light',
            document: documentLike,
            mutation,
            nextPreference: 'dark',
            platform: 'web',
            reduceMotion: false,
            systemTheme: 'light',
        });

        expect(startViewTransition).toHaveBeenCalledOnce();
        expect(mutation).toHaveBeenCalledOnce();
        expect(animate).toHaveBeenCalledWith(
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            expect.objectContaining({
                duration: 600,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
                fill: 'both',
                pseudoElement: '::view-transition-new(root)',
            }),
        );
    });

    it('waits for the web theme mutation to commit before starting the reveal animation', async () => {
        const events: string[] = [];
        let resolveCommit: () => void = () => {
            throw new Error('commit resolver was not initialized');
        };
        const mutation = vi.fn(() => {
            events.push('mutation');
        });
        const animate = vi.fn(() => {
            events.push('animate');
            return {} as Animation;
        });
        const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
            const updateResult = update();
            events.push(updateResult instanceof Promise ? 'update:async' : 'update:sync');
            return {
                ready: Promise.resolve(updateResult).then(() => {
                    events.push('ready');
                }),
            };
        });
        const documentLike = {
            documentElement: { animate },
            startViewTransition,
        } as unknown as Document;

        const runPromise = runThemePreferenceChange({
            currentPreference: 'light',
            document: documentLike,
            mutation,
            nextPreference: 'dark',
            platform: 'web',
            reduceMotion: false,
            systemTheme: 'light',
            webMutationCommit: async (commitMutation: () => void) => {
                events.push('commit:start');
                commitMutation();
                await new Promise<void>((resolve) => {
                    resolveCommit = resolve;
                });
                events.push('commit:end');
            },
        });

        await Promise.resolve();

        expect(events).toEqual(['commit:start', 'mutation', 'update:async']);
        expect(animate).not.toHaveBeenCalled();

        resolveCommit();
        await runPromise;

        expect(events).toEqual(['commit:start', 'mutation', 'update:async', 'commit:end', 'ready', 'animate']);
    });

    it('delegates native visual changes to the registered native controller', async () => {
        const mutation = vi.fn();
        const run = vi.fn(async (update: () => void) => update());

        const unregister = registerNativeThemePreferenceTransitionController({ run });
        try {
            await runThemePreferenceChange({
                currentPreference: 'light',
                mutation,
                nextPreference: 'dark',
                platform: 'ios',
                reduceMotion: false,
                systemTheme: 'light',
            });
        } finally {
            unregister();
        }

        expect(run).toHaveBeenCalledOnce();
        expect(mutation).toHaveBeenCalledOnce();
    });

    it('does not repeat the native mutation when the transition fails after applying it', async () => {
        const mutation = vi.fn();
        const run = vi.fn(async (update: () => void) => {
            update();
            throw new Error('native transition failed after mutation');
        });

        await runThemePreferenceChange({
            currentPreference: 'light',
            mutation,
            nativeController: { run },
            nextPreference: 'dark',
            platform: 'ios',
            reduceMotion: false,
            systemTheme: 'light',
        });

        expect(run).toHaveBeenCalledOnce();
        expect(mutation).toHaveBeenCalledOnce();
    });

    it('applies immediately when reduced motion is preferred', async () => {
        const mutation = vi.fn();
        const animate = vi.fn();
        const startViewTransition = vi.fn();
        const documentLike = {
            documentElement: { animate },
            startViewTransition,
        } as unknown as Document;

        await runThemePreferenceChange({
            currentPreference: 'light',
            document: documentLike,
            mutation,
            nextPreference: 'dark',
            platform: 'web',
            reduceMotion: true,
            systemTheme: 'light',
        });

        expect(mutation).toHaveBeenCalledOnce();
        expect(startViewTransition).not.toHaveBeenCalled();
        expect(animate).not.toHaveBeenCalled();
    });
});
