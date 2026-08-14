/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * PostHog project 129992's public write key (EU cloud).
     *
     * Typed here rather than left to the `Record<string, any>` fallback so a
     * typo like `VITE_POSTHOG_API_KEY` is a compile error instead of an
     * `undefined` that silently disables analytics — which is how the mobile
     * app's `EXPO_PUBLIC_POSTHOG_KEY` / `EXPO_PUBLIC_POSTHOG_API_KEY` alias pair
     * came to exist (apps/ui/sources/sync/runtime/appConfig.ts:120).
     */
    readonly VITE_POSTHOG_KEY?: string;
    readonly VITE_DOWNLOAD_STATS_URL?: string;
    readonly VITE_DISCORD_STATS_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
