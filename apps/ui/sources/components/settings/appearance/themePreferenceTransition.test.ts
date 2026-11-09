import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import {
    registerNativeThemePreferenceTransitionController,
    registerWebThemePreferenceChoreography,
    runThemePreferenceChange,
    shouldAnimateThemePreferenceChange,
} from './themePreferenceTransition';

it('passes the resolved theme direction to the native choreography owner', async () => {
    let direction: unknown;
    await runThemePreferenceChange({ currentPreference: 'light', nextPreference: 'adaptive', systemTheme: 'dark', platform: 'ios', reduceMotion: false,
        mutation: () => {}, nativeController: { run: (mutation, next?: unknown) => { direction = next; mutation(); } } });
    expect(direction).toBe('night');
});

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

    it('commits a hidden document theme without starting a transition or preparing choreography', async () => {
        const mutation = vi.fn();
        const animate = vi.fn();
        const startViewTransition = vi.fn((update: () => void) => {
            update();
            return { ready: Promise.resolve() };
        });
        const prepare = vi.fn();
        const unregister = registerWebThemePreferenceChoreography({ prepare });
        try {
            await runThemePreferenceChange({
                currentPreference: 'light', nextPreference: 'dark', systemTheme: 'light',
                platform: 'web', reduceMotion: false, forceAnimate: true, mutation,
                document: { visibilityState: 'hidden', documentElement: { animate }, startViewTransition } as unknown as Document,
            });
        } finally { unregister(); }
        expect(mutation).toHaveBeenCalledOnce();
        expect(startViewTransition).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(animate).not.toHaveBeenCalled();
    });

    it('keeps the committed theme when the document becomes hidden before the transition is ready', async () => {
        const ready = createDeferred<void>();
        const mutation = vi.fn();
        const animate = vi.fn();
        const documentLike = {
            visibilityState: 'visible', documentElement: { animate },
            startViewTransition: (update: () => void) => {
                update();
                return { ready: ready.promise, updateCallbackDone: Promise.resolve() };
            },
        };
        const run = runThemePreferenceChange({
            currentPreference: 'light', nextPreference: 'dark', systemTheme: 'light',
            platform: 'web', reduceMotion: false, mutation, document: documentLike as unknown as Document,
        });
        const result = expect(run).resolves.toBeUndefined();
        documentLike.visibilityState = 'hidden';
        ready.reject(new DOMException('Transition skipped for hidden document', 'InvalidStateError'));
        await result;
        expect(mutation).toHaveBeenCalledOnce();
        expect(animate).not.toHaveBeenCalled();
    });

    it('preserves a failed web theme mutation when a transition is skipped', async () => {
        const failure = new Error('theme mutation failed');
        const documentLike = {
            visibilityState: 'visible', documentElement: { animate: vi.fn() },
            startViewTransition: (update: () => void) => {
                const done = Promise.resolve().then(update);
                return { ready: done.then(() => { throw new DOMException('Skipped', 'InvalidStateError'); }), updateCallbackDone: done };
            },
        };
        await expect(runThemePreferenceChange({
            currentPreference: 'light', nextPreference: 'dark', systemTheme: 'light',
            platform: 'web', reduceMotion: false, mutation: () => { throw failure; },
            document: documentLike as unknown as Document,
        })).rejects.toBe(failure);
    });

    it('hands the web reveal to a registered choreography, prepared before the old view is captured', async () => {
        const events: string[] = [];
        const animate = vi.fn();
        const transition = { ready: Promise.resolve() };
        const startViewTransition = vi.fn((update: () => void) => {
            events.push('start');
            update();
            return transition;
        });
        const documentLike = { documentElement: { animate }, startViewTransition } as unknown as Document;
        const play = vi.fn(() => { events.push('play'); });
        const prepare = vi.fn(() => { events.push('prepare'); return play; });
        const unregister = registerWebThemePreferenceChoreography({ prepare });
        try {
            await runThemePreferenceChange({
                currentPreference: 'dark', document: documentLike, mutation: () => events.push('mutation'),
                nextPreference: 'light', platform: 'web', reduceMotion: false, systemTheme: 'dark',
            });
        } finally {
            unregister();
        }
        expect(prepare).toHaveBeenCalledWith(documentLike, 'sunrise');
        expect(play).toHaveBeenCalledWith(transition);
        expect(events).toEqual(['prepare', 'start', 'mutation', 'play']);
        expect(animate).not.toHaveBeenCalled();

        await runThemePreferenceChange({
            currentPreference: 'light', document: documentLike, mutation: () => {},
            nextPreference: 'dark', platform: 'web', reduceMotion: false, systemTheme: 'dark',
        });
        expect(prepare).toHaveBeenCalledOnce();
        expect(animate).toHaveBeenCalledOnce();
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

    it('rejects a failed settings mutation inside the native transition', async () => {
        const failure = new Error('settings scope changed');
        await expect(runThemePreferenceChange({
            currentPreference: 'light',
            nextPreference: 'dark',
            platform: 'ios',
            reduceMotion: false,
            systemTheme: 'light',
            nativeController: { run: async update => update() },
            mutation: () => { throw failure; },
        })).rejects.toBe(failure);
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
