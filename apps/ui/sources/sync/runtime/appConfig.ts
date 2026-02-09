import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface AppConfig {
    postHogKey?: string;
    revenueCatAppleKey?: string;
    revenueCatGoogleKey?: string;
    revenueCatStripeKey?: string;
    serverUrl?: string;
    enableDevPushTokenRegistration?: boolean;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
    if (!value) return undefined;
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return undefined;
}

/**
 * Loads app configuration from various manifest sources.
 * Looks for the "app" field in expoConfig.extra across different manifests
 * and merges them into a single configuration object.
 * 
 * Priority (later overrides earlier):
 * 1. ExponentConstants native module manifest (fetches embedded manifest)
 * 2. Constants.expoConfig
 */
export function loadAppConfig(): AppConfig {
    const config: Partial<AppConfig> = {};

    try {
        // 1. Try ExponentConstants native module directly
        const ExponentConstants = requireOptionalNativeModule('ExponentConstants');
        if (ExponentConstants && ExponentConstants.manifest) {
            let exponentManifest = ExponentConstants.manifest;

            // On Android, manifest is passed as JSON string
            if (typeof exponentManifest === 'string') {
                try {
                    exponentManifest = JSON.parse(exponentManifest);
                } catch (e) {
                    console.warn('[loadAppConfig] Failed to parse ExponentConstants.manifest:', e);
                }
            }

            // Look for app config in various locations
            const appConfig = exponentManifest?.extra?.app;
            if (appConfig && typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                if (__DEV__) console.log('[loadAppConfig] Loaded from ExponentConstants:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing ExponentConstants:', e);
    }

    try {
        // 2. Try Constants.expoConfig
        if (Constants.expoConfig?.extra?.app) {
            const appConfig = Constants.expoConfig.extra.app;
            if (typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                if (__DEV__) console.log('[loadAppConfig] Loaded from Constants.expoConfig:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing Constants.expoConfig:', e);
    }

    // Override with EXPO_PUBLIC_* env vars if present at runtime and different
    // Why: Native config is baked at prebuild time, but EXPO_PUBLIC_* vars
    // are available at runtime via process.env. This allows devs to change
    // keys without rebuilding native code.
    if (process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE && config.revenueCatAppleKey !== process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE) {
        if (__DEV__) console.log('[loadAppConfig] Override revenueCatAppleKey from EXPO_PUBLIC_REVENUE_CAT_APPLE');
        config.revenueCatAppleKey = process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE;
    }
    if (process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE && config.revenueCatGoogleKey !== process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE) {
        if (__DEV__) console.log('[loadAppConfig] Override revenueCatGoogleKey from EXPO_PUBLIC_REVENUE_CAT_GOOGLE');
        config.revenueCatGoogleKey = process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE;
    }
    if (process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE && config.revenueCatStripeKey !== process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE) {
        if (__DEV__) console.log('[loadAppConfig] Override revenueCatStripeKey from EXPO_PUBLIC_REVENUE_CAT_STRIPE');
        config.revenueCatStripeKey = process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE;
    }
    if (process.env.EXPO_PUBLIC_POSTHOG_KEY && config.postHogKey !== process.env.EXPO_PUBLIC_POSTHOG_KEY) {
        if (__DEV__) console.log('[loadAppConfig] Override postHogKey from EXPO_PUBLIC_POSTHOG_KEY');
        config.postHogKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
    }
    if (process.env.EXPO_PUBLIC_SERVER_URL && config.serverUrl !== process.env.EXPO_PUBLIC_SERVER_URL) {
        if (__DEV__) console.log('[loadAppConfig] Override serverUrl from EXPO_PUBLIC_SERVER_URL');
        config.serverUrl = process.env.EXPO_PUBLIC_SERVER_URL;
    }

    const enableDevPushFromEnv = parseBooleanEnv(process.env.EXPO_PUBLIC_ENABLE_DEV_PUSH_TOKEN_REGISTRATION);
    if (enableDevPushFromEnv !== undefined && config.enableDevPushTokenRegistration !== enableDevPushFromEnv) {
        if (__DEV__) console.log('[loadAppConfig] Override enableDevPushTokenRegistration from EXPO_PUBLIC_ENABLE_DEV_PUSH_TOKEN_REGISTRATION');
        config.enableDevPushTokenRegistration = enableDevPushFromEnv;
    }

    return config as AppConfig;
}
