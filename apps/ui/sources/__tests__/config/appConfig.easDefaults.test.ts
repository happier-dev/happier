import { getConfig } from '@expo/config';
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_EAS_PROJECT_ID = '2a550bd7-e4d2-4f59-ab47-dcb778775cee';
const DEFAULT_UPDATES_URL = `https://u.expo.dev/${DEFAULT_EAS_PROJECT_ID}`;

function getUiDir(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function clearDynamicConfigModuleCache(): void {
    const uiDir = getUiDir();
    const nodeRequire = createRequire(import.meta.url);
    const cacheTargets = [
        join(uiDir, 'app.config.js'),
        join(uiDir, 'appVariantConfig.cjs'),
        join(uiDir, 'app.local.js'),
        join(uiDir, 'sources', '__tests__', 'config', 'fixtures', 'app.local.fixture.cjs'),
    ];

    for (const target of cacheTargets) {
        try {
            const resolved = nodeRequire.resolve(target);
            delete nodeRequire.cache[resolved];
        } catch {
            // Ignore files that are absent in the current test setup.
        }
    }
}

function getPublicConfig() {
    clearDynamicConfigModuleCache();
    return getConfig(getUiDir(), { skipSDKVersionRequirement: true, isPublicConfig: true }).exp;
}

function getPluginOptions(exp: ReturnType<typeof getPublicConfig>, pluginName: string) {
    const pluginEntry = Array.isArray(exp.plugins)
        ? exp.plugins.find((entry) => Array.isArray(entry) && entry[0] === pluginName)
        : undefined;

    return Array.isArray(pluginEntry) ? pluginEntry[1] : undefined;
}

function withCleanEnv<T>(fn: () => T): T {
    const keys = [
        'APP_ENV',
        'HAPPIER_APP_VARIANT_OVERRIDE',
        'EXPO_PUBLIC_EAS_PROJECT_ID',
        'EAS_PROJECT_ID',
        'EXPO_EAS_PROJECT_ID',
        'EXPO_UPDATES_URL',
        'EXPO_UPDATES_CHANNEL',
        'EXPO_APP_VERSION',
        'EXPO_APP_OWNER',
        'EXPO_APP_SLUG',
        'EXPO_APP_BUNDLE_ID',
        'EXPO_ANDROID_PACKAGE',
        'HAPPIER_EXPO_RUNTIME_VERSION',
        'HAPPIER_EXPO_RUNTIME_VERSION_POLICY',
        'EXPO_APP_LOCAL_CONFIG_PATH',
        'EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV',
        'EXPO_PUBLIC_IOS_BACKGROUND_AUDIO',
        'EXPO_IOS_BACKGROUND_AUDIO',
        'HAPPIER_ANDROID_USES_CLEARTEXT_TRAFFIC',
        'EXPO_PUBLIC_IOS_LIVE_ACTIVITIES_FREQUENT_UPDATES',
        'EXPO_IOS_LIVE_ACTIVITIES_FREQUENT_UPDATES',
        'EXPO_PUBLIC_IOS_LIVE_ACTIVITIES_PUSH_NOTIFICATIONS',
        'EXPO_IOS_LIVE_ACTIVITIES_PUSH_NOTIFICATIONS',
        'EXPO_PUBLIC_HAPPIER_IOS_APNS_ENVIRONMENT',
        'EXPO_IOS_APNS_ENVIRONMENT',
        'HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE',
        'HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH',
        'HAPPIER_EXPO_DEVCLIENT_ADD_GENERATED_SCHEME',
        'HAPPIER_EXPO_USE_NATIVE_DEBUG',
        'EX_UPDATES_NATIVE_DEBUG',
        'EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON',
        'HAPPIER_SYNC_TUNING_JSON',
    ] as const;

    const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
    for (const key of keys) {
        previous[key] = process.env[key];
        delete process.env[key];
    }
    try {
        return fn();
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

describe('app.config.js', () => {
    it('includes a default EAS project id so EAS can link dynamic configs', () => {
        const exp = withCleanEnv(() => getPublicConfig());

        expect(exp.extra?.eas?.projectId).toBe(DEFAULT_EAS_PROJECT_ID);
        expect(exp.updates?.url).toBe(DEFAULT_UPDATES_URL);
        expect(exp.extra?.app?.variant).toBe('development');
        expect(exp.extra?.app?.identityVariant).toBe('internaldev');
        expect(exp.owner).toBe('happier-dev');
        expect(exp.slug).toBe('happier');
        expect(exp.ios?.bundleIdentifier).toBe('dev.happier.app.dev.internal');
        expect(exp.android?.package).toBe('dev.happier.app.internaldev');
        expect(exp.scheme).toBe('happier-internaldev');
    });

    it('exposes variant under extra.app when APP_ENV is set', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });

        expect(exp.extra?.app?.variant).toBe('preview');
        expect(exp.extra?.app?.identityVariant).toBe('preview');
    });

    it('maps the publicdev environment to the public dev identity while keeping preview-like public behavior', () => {
        const { exp, featurePolicyEnv } = withCleanEnv(() => {
            process.env.APP_ENV = 'publicdev';
            const exp = getPublicConfig();
            return {
                exp,
                featurePolicyEnv: process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV,
            };
        });

        expect(exp.extra?.app?.variant).toBe('preview');
        expect(exp.extra?.app?.identityVariant).toBe('publicdev');
        expect(exp.name).toBe('Happier (dev)');
        expect(exp.ios?.bundleIdentifier).toBe('dev.happier.app.publicdev');
        expect(exp.android?.package).toBe('dev.happier.app.publicdev');
        expect(exp.scheme).toBe('happier-dev');
        expect(featurePolicyEnv).toBe('preview');
        expect(exp.updates?.requestHeaders?.['expo-channel-name']).toBe('dev');
    });

    it('does not use iOS bundle id overrides as Android package overrides', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_BUNDLE_ID = 'com.happier.local.leeroy.dev';
            return getPublicConfig();
        });

        expect(exp.ios?.bundleIdentifier).toBe('com.happier.local.leeroy.dev');
        expect(exp.android?.package).toBe('dev.happier.app.internaldev');
    });

    it('uses explicit Android package overrides independently from iOS bundle id overrides', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_BUNDLE_ID = 'com.happier.local.leeroy.dev';
            process.env.EXPO_ANDROID_PACKAGE = 'dev.happier.app.internaldev.devclient';
            return getPublicConfig();
        });

        expect(exp.ios?.bundleIdentifier).toBe('com.happier.local.leeroy.dev');
        expect(exp.android?.package).toBe('dev.happier.app.internaldev.devclient');
    });

    it('enables Android cleartext traffic by default through expo-build-properties so native manifests allow LAN/local HTTP relays', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        expect(getPluginOptions(exp, 'expo-build-properties')).toEqual(
            expect.objectContaining({
                android: expect.objectContaining({
                    usesCleartextTraffic: true,
                }),
            })
        );
    });

    it('enables enriched markdown native math dependencies', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        expect(getPluginOptions(exp, 'react-native-enriched-markdown')).toEqual({
            enableMath: true,
        });
    });

    it('allows disabling Android cleartext traffic explicitly via env override', () => {
        const exp = withCleanEnv(() => {
            process.env.HAPPIER_ANDROID_USES_CLEARTEXT_TRAFFIC = 'false';
            return getPublicConfig();
        });
        expect(getPluginOptions(exp, 'expo-build-properties')).toEqual(
            expect.objectContaining({
                android: expect.objectContaining({
                    usesCleartextTraffic: false,
                }),
            })
        );
    });

    it('maps the internalpreview environment to the internal preview identity', () => {
        const { exp, featurePolicyEnv } = withCleanEnv(() => {
            process.env.APP_ENV = 'internalpreview';
            const exp = getPublicConfig();
            return {
                exp,
                featurePolicyEnv: process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV,
            };
        });

        expect(exp.extra?.app?.variant).toBe('preview');
        expect(exp.extra?.app?.identityVariant).toBe('internalpreview');
        expect(exp.name).toBe('Happier (internal preview)');
        expect(exp.ios?.bundleIdentifier).toBe('dev.happier.app.internalpreview');
        expect(exp.android?.package).toBe('dev.happier.app.internalpreview');
        expect(exp.scheme).toBe('happier-internalpreview');
        expect(featurePolicyEnv).toBe('preview');
        expect(exp.updates?.requestHeaders?.['expo-channel-name']).toBe('internalpreview');
    });

    it('allows overriding extra.app.variant without changing production identity config', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'production';
            process.env.HAPPIER_APP_VARIANT_OVERRIDE = 'preview';
            return getPublicConfig();
        });

        expect(exp.extra?.app?.variant).toBe('preview');
        // Production identity still enables universal links / app links.
        expect(exp.ios?.associatedDomains).toEqual(['applinks:app.happier.dev']);
        const data = exp.android?.intentFilters?.[0]?.data;
        const dataItems = Array.isArray(data) ? data : data ? [data] : [];
        expect(dataItems[0]?.host).toBe('app.happier.dev');
    });

    it('uses the ui package.json version for expo.version by default', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        // Avoid pinning a literal version; keep config tied to the package version.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        expect(exp.version).toBe(pkg.version);
    });

    it('defaults EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV based on the app variant', () => {
        const envValue = withCleanEnv(() => {
            process.env.APP_ENV = 'production';
            getPublicConfig();
            return process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
        });

        expect(envValue).toBe('production');
    });

    it('uses the configured native runtime train for internaldev OTA updates', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        expect(exp.runtimeVersion).toBe(pkg.happierExpoRuntimeVersion);
    });

    it('uses the configured native runtime train for internalpreview OTA updates', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'internalpreview';
            return getPublicConfig();
        });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        expect(exp.runtimeVersion).toBe(pkg.happierExpoRuntimeVersion);
    });

    it('keeps Expo fingerprint runtime policy for the publicdev lane', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'publicdev';
            return getPublicConfig();
        });
        expect(exp.runtimeVersion).toEqual({ policy: 'fingerprint' });
    });

    it('uses the configured native runtime train for preview lane OTA updates', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        expect(exp.runtimeVersion).toBe(pkg.happierExpoRuntimeVersion);
    });

    it('uses the configured native runtime train for production lane OTA updates', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'production';
            return getPublicConfig();
        });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../../package.json');
        expect(exp.runtimeVersion).toBe(pkg.happierExpoRuntimeVersion);
    });

    it('allows forcing an explicit Expo runtime version for maintenance OTA trains', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            process.env.HAPPIER_EXPO_RUNTIME_VERSION = '18';
            return getPublicConfig();
        });

        expect(exp.runtimeVersion).toBe('18');
    });

    it('does not set newArchEnabled because SDK 55+ always enables the new architecture', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        expect('newArchEnabled' in exp).toBe(false);
    });

    it('uses EXPO_PUBLIC_EAS_PROJECT_ID with highest precedence for updates linkage', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'public-project-id';
            process.env.EAS_PROJECT_ID = 'eas-project-id';
            process.env.EXPO_EAS_PROJECT_ID = 'expo-project-id';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('public-project-id');
        expect(exp.updates?.url).toBe('https://u.expo.dev/public-project-id');
    });

    it('forwards sync tuning JSON into extra.app for native release builds', () => {
        const tuningJson = JSON.stringify({
            syncPerformanceTelemetryEnabled: true,
            nativeCryptoWorkerMode: 'auto',
        });
        const exp = withCleanEnv(() => {
            process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON = tuningJson;
            return getPublicConfig();
        });

        expect(exp.extra?.app?.syncTuningJson).toBe(tuningJson);
    });

    it('uses EAS_PROJECT_ID when EXPO_PUBLIC_EAS_PROJECT_ID is unset', () => {
        const exp = withCleanEnv(() => {
            process.env.EAS_PROJECT_ID = 'eas-project-id';
            process.env.EXPO_EAS_PROJECT_ID = 'expo-project-id';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('eas-project-id');
        expect(exp.updates?.url).toBe('https://u.expo.dev/eas-project-id');
    });

    it('allows EXPO_UPDATES_URL override while keeping project id override intact', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'public-project-id';
            process.env.EXPO_UPDATES_URL = 'https://updates.example.test/custom';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('public-project-id');
        expect(exp.updates?.url).toBe('https://updates.example.test/custom');
    });

    it('allows owner and slug overrides for local variants', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_OWNER = 'example-owner';
            process.env.EXPO_APP_SLUG = 'example-slug';
            return getPublicConfig();
        });

        expect(exp.owner).toBe('example-owner');
        expect(exp.slug).toBe('example-slug');
        expect(exp.extra?.eas?.projectId).toBe(DEFAULT_EAS_PROJECT_ID);
    });

    it('enables iOS background audio by default in development', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'development';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: true })]);
    });

    it('enables iOS background audio by default in preview', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: true })]);
    });

    it('allows overriding iOS background audio via env', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            process.env.EXPO_PUBLIC_IOS_BACKGROUND_AUDIO = 'false';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: false })]);
    });

    it('bundles Happier notification sounds through expo-notifications', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        const uiDir = getUiDir();

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-notifications');
        expect(plugin).toEqual([
            'expo-notifications',
            expect.objectContaining({
                sounds: [
                    './sources/assets/sounds/happier_soft.wav',
                    './sources/assets/sounds/happier_urgent.wav',
                ],
            }),
        ]);
        expect(plugin).toEqual([
            'expo-notifications',
            expect.objectContaining({
                enableBackgroundRemoteNotifications: true,
            }),
        ]);
        expect(exp.extra?.app?.iosBackgroundWakeNotificationsEnabled).toBe(true);
        expect(existsSync(join(uiDir, 'sources/assets/sounds/happier_soft.wav'))).toBe(true);
        expect(existsSync(join(uiDir, 'sources/assets/sounds/happier_urgent.wav'))).toBe(true);
    });

    it('does not enable OTA-native debug development-client launch overrides by default', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'development';
            return getPublicConfig();
        });

        const devClientPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-dev-client');
        expect(devClientPlugin).toBeUndefined();
        expect(exp.developmentClient?.silentLaunch).toBeUndefined();
        expect(exp.updates?.useNativeDebug).toBeUndefined();
    });

    it('enables OTA-native debug development-client behavior only when explicitly requested by env', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'development';
            process.env.HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE = 'most-recent';
            process.env.HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH = 'true';
            process.env.HAPPIER_EXPO_USE_NATIVE_DEBUG = 'true';
            return getPublicConfig();
        });

        const devClientPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-dev-client');
        expect(devClientPlugin).toEqual(['expo-dev-client', expect.objectContaining({ launchMode: 'most-recent' })]);
        expect(exp.developmentClient?.silentLaunch).toBe(true);
        expect(exp.updates?.useNativeDebug).toBe(true);
    });

    it('can opt Expo dev-client out of generated exp slug URL schemes for local app isolation', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'development';
            process.env.HAPPIER_EXPO_DEVCLIENT_ADD_GENERATED_SCHEME = '0';
            return getPublicConfig();
        });

        const devClientPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-dev-client');
        expect(devClientPlugin).toEqual(['expo-dev-client', expect.objectContaining({ addGeneratedScheme: false })]);
    });

    it('does not include unused optional native plugins in the default config', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        const pluginNames = (exp.plugins ?? []).map((entry: any) => (Array.isArray(entry) ? entry[0] : entry));

        expect(pluginNames).not.toContain('expo-location');
        expect(pluginNames).not.toContain('expo-calendar');
    });

    it('configures expo-widgets with the canonical public widget and live-activity kinds', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        const widgetPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-widgets');

        expect(widgetPlugin).toEqual([
            'expo-widgets',
            expect.objectContaining({
                widgets: [
                    expect.objectContaining({
                        name: 'HappierFocusWidget',
                        displayName: 'Happier Focus',
                    }),
                    expect.objectContaining({
                        name: 'HappierSessionsWidget',
                        displayName: 'Happier Sessions',
                    }),
                    expect.objectContaining({
                        name: 'HappierFocusLiveActivity',
                        displayName: 'Happier Focus Live',
                        supportedFamilies: ['accessoryRectangular'],
                    }),
                ],
            }),
        ]);
    });

    it('maps the live-activity frequent-updates flag through the expo-widgets plugin config', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_IOS_LIVE_ACTIVITIES_FREQUENT_UPDATES = 'true';
            return getPublicConfig();
        });
        const widgetPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-widgets');

        expect(widgetPlugin).toEqual([
            'expo-widgets',
            expect.objectContaining({
                frequentUpdates: true,
            }),
        ]);
    });

    it('enables ActivityKit push notifications in the expo-widgets plugin config by default', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        const widgetPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-widgets');

        expect(widgetPlugin).toEqual([
            'expo-widgets',
            expect.objectContaining({
                enablePushNotifications: true,
            }),
        ]);
        expect(exp.extra?.app?.iosLiveActivityPushNotificationsEnabled).toBe(true);
    });

    it('publishes disabled ActivityKit push support when the static widget push flag is disabled', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_IOS_LIVE_ACTIVITIES_PUSH_NOTIFICATIONS = 'false';
            return getPublicConfig();
        });
        const widgetPlugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'expo-widgets');

        expect(widgetPlugin).toEqual([
            'expo-widgets',
            expect.objectContaining({
                enablePushNotifications: false,
            }),
        ]);
        expect(exp.extra?.app?.iosLiveActivityPushNotificationsEnabled).toBe(false);
    });

    it('publishes the APNs environment used for ActivityKit token registration', () => {
        const production = withCleanEnv(() => {
            process.env.APP_ENV = 'production';
            return getPublicConfig();
        });
        const preview = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });

        expect(production.extra?.app?.happierLiveActivityApnsEnvironment).toBe('production');
        expect(preview.extra?.app?.happierLiveActivityApnsEnvironment).toBe('sandbox');
    });

    it('prefixes the widget extension bundle identifier with the active iOS app bundle identifier', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_BUNDLE_ID = 'dev.happier.app.dev.next-dev.devclient';
            return getPublicConfig();
        });

        expect(getPluginOptions(exp, 'expo-widgets')).toEqual(
            expect.objectContaining({
                bundleIdentifier: 'dev.happier.app.dev.next-dev.devclient.ExpoWidgetsTarget',
            })
        );
    });

    it('includes iOS privacy purpose strings required by App Store static analysis', () => {
        const exp = withCleanEnv(() => getPublicConfig());

        expect(exp.ios?.infoPlist?.NSPhotoLibraryUsageDescription).toBeTruthy();
        expect(exp.ios?.infoPlist?.NSPhotoLibraryAddUsageDescription).toBeTruthy();
        expect(exp.ios?.infoPlist?.NSLocationWhenInUseUsageDescription).toBeTruthy();
    });

    it('applies app.local overrides when a local config file is provided', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_LOCAL_CONFIG_PATH = join(
                getUiDir(),
                'sources',
                '__tests__',
                'config',
                'fixtures',
                'app.local.fixture.cjs',
            );
            return getPublicConfig();
        });

        expect(exp.name).toBe('Happier (local override)');
        expect(exp.ios?.infoPlist?.NSPhotoLibraryUsageDescription).toBe(
            'Local override: access photos for sharing.',
        );
    });
});
