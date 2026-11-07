// Vitest/node stub for `expo-share-intent` (native module; its build output ships JSX).

export function useShareIntent() {
    return {
        isReady: true,
        hasShareIntent: false,
        shareIntent: { type: null, text: null, webUrl: null, files: null },
        resetShareIntent: () => {},
        error: null,
    };
}
