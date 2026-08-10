import { describe, expect, it, vi } from 'vitest';

/**
 * Native contract — the composer suggestion registry resolves its dependencies when
 * the registry itself is loaded, never at interaction time.
 *
 * On native this is not an implementation detail, it is the difference between a
 * working picker and a dead one. Expo's dev server enables lazy bundling, so a
 * first-party `await import('<module>')` does not become a local registry lookup: it
 * becomes `__loadBundleAsync('<module>.bundle?…&modulesOnly=true')`, an HTTP fetch of
 * that module's entire remaining subgraph performed at call time.
 * `utils/platform/loadExpoNotifications.ts` documents the same mechanism for
 * `expo-notifications`, where the promise "pending forever" already had to be bounded.
 *
 * Measured on an iOS dev client (lane N1, 2026-08-10) by wrapping
 * `globalThis.__loadBundleAsync` and driving the real composer:
 *
 *   /apps/ui/sources/sync/domains/input/suggestionFile.bundle             pending 620 s
 *   /apps/ui/…/slashCommands/promptInvocationSuggestion.bundle            pending 206 s
 *
 * The `suggestionFile` chunk is 68 MB; the device request never completed, the module
 * was never initialized, the `file` kind never settled and typing `@` showed nothing.
 * The same load hung `applySelection`, so tapping a prompt-template row did nothing.
 * `/` kept working only because its resolver is imported statically.
 *
 * A mock factory runs the first time its module is requested, so recording the order
 * distinguishes an eager (static) dependency from one deferred to `resolve()` /
 * `applySelection()` — which is exactly the distinction the device cares about.
 */

const moduleLoads = vi.hoisted(() => [] as string[]);

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

vi.mock('@/sync/domains/input/suggestionFile', () => {
    moduleLoads.push('suggestionFile');
    return { searchFiles: vi.fn(async () => []) };
});

vi.mock('@/sync/domains/input/slashCommands/promptInvocationSuggestion', () => {
    moduleLoads.push('promptInvocationSuggestion');
    return {
        resolvePromptInvocationAutocompleteSelection: vi.fn(async () => ({ handled: false as const })),
    };
});

describe('composer suggestion registry — native module loading', () => {
    it('loads the file-search and prompt-invocation modules with the registry itself', async () => {
        await import('./composerSuggestionKinds');

        expect(moduleLoads).toContain('suggestionFile');
        expect(moduleLoads).toContain('promptInvocationSuggestion');
    });
});
