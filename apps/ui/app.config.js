const path = require('node:path');
const { createRequire } = require('node:module');

const appConfigRequire = createRequire(__filename);

function requireFromAppConfig(modulePath) {
    const resolvedPath = path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(__dirname, modulePath);
    return appConfigRequire(resolvedPath);
}

const { getAppEnvironmentConfig } = requireFromAppConfig('./appVariantConfig.cjs');

function normalizeVariantOverride(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return '';
    if (value === 'preview' || value.includes('preview')) return 'preview';
    if (value === 'development' || value === 'dev' || value.endsWith('dev') || value.includes('development')) return 'development';
    if (
        value === 'production' ||
        value === 'prod' ||
        value === 'stable' ||
        value.includes('production') ||
        value.includes('stable')
    ) {
        return 'production';
    }
    return '';
}

function readBoolEnv(name, defaultValue = false) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return defaultValue;
}

function resolveOptionalAppLocalConfigModule() {
    const explicitPath = (process.env.EXPO_APP_LOCAL_CONFIG_PATH || '').trim();
    const candidates = explicitPath ? [explicitPath] : ['./app.local.js'];

    for (const candidatePath of candidates) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = requireFromAppConfig(candidatePath);
            return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
        } catch (error) {
            if (explicitPath) {
                throw error;
            }
        }
    }

    return null;
}

const appLocalConfigModule = resolveOptionalAppLocalConfigModule();
if (appLocalConfigModule && typeof appLocalConfigModule === 'object') {
    const envOverrides = appLocalConfigModule.env;
    if (envOverrides && typeof envOverrides === 'object') {
        for (const [key, value] of Object.entries(envOverrides)) {
            if (typeof key === 'string') {
                process.env[key] = value == null ? '' : String(value);
            }
        }
    }
}

const DEFAULTS = {
    owner: "happier-dev",
    slug: "happier",
    easProjectId: "2a550bd7-e4d2-4f59-ab47-dcb778775cee",
    linkHost: "app.happier.dev",
};

// Allow opt-in overrides for local dev tooling without changing upstream defaults.
const nameOverride = (process.env.EXPO_APP_NAME || process.env.HAPPY_STACKS_IOS_APP_NAME || '').trim();
const iosBundleIdOverride = (process.env.EXPO_APP_BUNDLE_ID || process.env.HAPPY_STACKS_IOS_BUNDLE_ID || '').trim();
const androidPackageOverride = (process.env.EXPO_ANDROID_PACKAGE || '').trim();
const ownerOverride = (process.env.EXPO_APP_OWNER || '').trim();
const slugOverride = (process.env.EXPO_APP_SLUG || '').trim();
const versionOverride = (process.env.EXPO_APP_VERSION || '').trim();
const appVariantOverride = normalizeVariantOverride(process.env.HAPPIER_APP_VARIANT_OVERRIDE);
const packageJson = (() => {
    try {
        return requireFromAppConfig('./package.json');
    } catch {
        return null;
    }
})();
const packageJsonVersion =
    packageJson && typeof packageJson.version === 'string'
        ? packageJson.version.trim()
        : '';
const packageJsonRuntimeVersion =
    packageJson && typeof packageJson.happierExpoRuntimeVersion === 'string'
        ? packageJson.happierExpoRuntimeVersion.trim()
        : '';

const rawAppEnvironment = process.env.APP_ENV || 'development';
const appEnvironmentConfig = getAppEnvironmentConfig(rawAppEnvironment);

// Android size tuning (primarily for direct-download APKs).
// Prefer controlling these knobs from EAS build profile env so store builds (AAB) keep their defaults.
const androidEnableMinifyInReleaseBuilds = readBoolEnv('HAPPIER_ANDROID_ENABLE_MINIFY', false);
const androidEnableShrinkResourcesInReleaseBuilds = readBoolEnv('HAPPIER_ANDROID_ENABLE_SHRINK_RESOURCES', false);
const androidGradleJvmArgsOverride = String(process.env.HAPPIER_ANDROID_GRADLE_JVMARGS ?? '').trim();
const androidUsesCleartextTraffic = readBoolEnv('HAPPIER_ANDROID_USES_CLEARTEXT_TRAFFIC', true);
// Canonical owner of the generated native build properties. Every prebuild path derives
// ios/Podfile.properties.json from this: `yarn prebuild`, `expo run:ios`, `hstack mobile`,
// and EAS (which re-prebuilds because /ios/ is .easignore'd).
//
// `ios.buildReactNativeFromSource` is load-bearing, not a preference: patches/ edits React
// Native core .mm sources (composer caret reveal + jiggle, ScrollView MVCP). With prebuilt
// RNCore, React-RCTFabric compiles headers only, so those patches apply to node_modules and
// are then silently discarded at compile time. `deploymentTarget` stays at 16.4 because the
// ExpoGlassEffect pod refuses to build below it.
// Enforced by the verify-native-patch-compilation postinstall task.
const expoBuildPropertiesPlugin = [
    "expo-build-properties",
    {
        android: {
            usesCleartextTraffic: androidUsesCleartextTraffic === true,
        },
        ios: {
            buildReactNativeFromSource: true,
            deploymentTarget: "16.4",
        },
    },
];
const shouldUseAndroidReleaseShrinkerPlugin =
    androidEnableMinifyInReleaseBuilds || androidEnableShrinkResourcesInReleaseBuilds;
const nativeSshTransportEnabled = readBoolEnv('HAPPIER_ENABLE_NATIVE_SSH', false);
const terminalNativeRendererEnabled = process.env.HAPPIER_ENABLE_TERMINAL_NATIVE === '1';
const nativeAutolinkingSearchPaths = [
    "../../node_modules",
    "./node_modules",
];
const excludedOptionalNativeModules = [
    ...(nativeSshTransportEnabled ? [] : ["@happier-dev/ssh-native"]),
    ...(terminalNativeRendererEnabled ? [] : ["@happier-dev/terminal-native"]),
];
const optionalNativeAutolinkingConfig = {
    searchPaths: nativeAutolinkingSearchPaths,
    ...(excludedOptionalNativeModules.length === 0
        ? {}
        : {
            exclude: excludedOptionalNativeModules,
            ios: {
                exclude: excludedOptionalNativeModules,
            },
            android: {
                exclude: excludedOptionalNativeModules,
            },
        }),
};

const androidReleaseShrinkerPlugin = shouldUseAndroidReleaseShrinkerPlugin
    ? [
        require("./plugins/withAndroidReleaseShrinker.js"),
        {
            enableMinifyInReleaseBuilds: androidEnableMinifyInReleaseBuilds === true,
            enableShrinkResourcesInReleaseBuilds: androidEnableShrinkResourcesInReleaseBuilds === true,
            ...(androidGradleJvmArgsOverride ? { gradleJvmArgs: androidGradleJvmArgsOverride } : {}),
        },
    ]
    : null;
const appVariant = appEnvironmentConfig.logicalVariant;
const appIdentityVariant = appEnvironmentConfig.id;

// If APP_ENV is unknown, fall back to development-safe defaults to avoid generating
// an invalid Expo config with undefined identifiers.
const name = nameOverride || appEnvironmentConfig.name;
const iosBundleId = iosBundleIdOverride || appEnvironmentConfig.iosBundleId;
const androidPackage = androidPackageOverride || appEnvironmentConfig.androidPackage;
const owner = ownerOverride || DEFAULTS.owner;
const slug = slugOverride || DEFAULTS.slug;

// IMPORTANT:
// Expo Updates uses a project-scoped UUID (EAS project id). EAS cannot write this automatically when
// using a dynamic config (app.config.js), so we ship a default and allow env overrides.
const easProjectId =
    (
        process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
        process.env.EAS_PROJECT_ID ||
        process.env.EXPO_EAS_PROJECT_ID ||
        ''
    ).trim() || DEFAULTS.easProjectId;

const parseOptionalBoolean = (raw) => {
    const value = (raw ?? '').toString().trim().toLowerCase();
    if (!value) return null;
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
    return null;
};

const explicitRuntimeVersion = String(process.env.HAPPIER_EXPO_RUNTIME_VERSION ?? '').trim();

function resolveDefaultExpoRuntimeVersion() {
    const overrideRaw = String(process.env.HAPPIER_EXPO_RUNTIME_VERSION_POLICY ?? '').trim().toLowerCase();
    const override =
        overrideRaw === 'fingerprint' ? 'fingerprint' :
        overrideRaw === 'appversion' || overrideRaw === 'app_version' || overrideRaw === 'app-version' ? 'appVersion' :
        '';

    if (override) {
        return { policy: override };
    }

    // publicdev is the only lane that should keep following fingerprint-based native compatibility.
    if (appIdentityVariant === 'publicdev') {
        return { policy: 'fingerprint' };
    }

    if (!packageJsonRuntimeVersion) {
        throw new Error('apps/ui/package.json must define happierExpoRuntimeVersion for non-publicdev Expo lanes');
    }

    return packageJsonRuntimeVersion;
}

const devClientLaunchMode = (process.env.HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE || '').trim();
const devClientSilentLaunch = parseOptionalBoolean(process.env.HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH);
const devClientAddGeneratedScheme = parseOptionalBoolean(process.env.HAPPIER_EXPO_DEVCLIENT_ADD_GENERATED_SCHEME);
const devClientPluginOptions = {
    ...(devClientLaunchMode ? { launchMode: devClientLaunchMode } : {}),
    ...(devClientAddGeneratedScheme !== null ? { addGeneratedScheme: devClientAddGeneratedScheme } : {}),
};
const updatesNativeDebugEnabled =
    parseOptionalBoolean(process.env.HAPPIER_EXPO_USE_NATIVE_DEBUG) ??
    parseOptionalBoolean(process.env.EX_UPDATES_NATIVE_DEBUG) ??
    null;

const updatesUrl = (process.env.EXPO_UPDATES_URL || '').trim() || `https://u.expo.dev/${easProjectId}`;
const updatesChannel = (process.env.EXPO_UPDATES_CHANNEL || '').trim() || appEnvironmentConfig.updatesChannel;
const updatesConfig = {
    url: updatesUrl,
    requestHeaders: {
        "expo-channel-name": updatesChannel
    },
    ...(updatesNativeDebugEnabled === true ? { useNativeDebug: true } : {})
};

const normalizeCiFlag = (raw) => {
    const value = String(raw ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
};

const isBuildContext =
    normalizeCiFlag(process.env.CI) ||
    normalizeCiFlag(process.env.EAS_BUILD);

const variantFeaturePolicyEnv = appEnvironmentConfig.featurePolicyEnv;
const buildFeaturePolicyEnv =
    updatesChannel === 'production' ? 'production' : updatesChannel === 'preview' ? 'preview' : '';
const resolvedFeaturePolicyEnv = variantFeaturePolicyEnv || (isBuildContext ? buildFeaturePolicyEnv : '');
if (!process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV && resolvedFeaturePolicyEnv) {
    process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV = resolvedFeaturePolicyEnv;
}

const linkHost = (process.env.EXPO_APP_LINK_HOST || DEFAULTS.linkHost).trim();
const iosAssociatedDomainsRaw = (process.env.EXPO_IOS_ASSOCIATED_DOMAINS || '').trim();
const iosAssociatedDomains = iosAssociatedDomainsRaw
    ? iosAssociatedDomainsRaw.split(/[\s,]+/).map(v => v.trim()).filter(Boolean)
    : [`applinks:${linkHost}`];

// NOTE:
// The URL scheme is used for deep linking *and* by the Expo development client launcher flow.
// Keep the default stable for upstream users, but allow opt-in overrides for local dev variants
// (e.g. to avoid iOS scheme collisions between multiple installs).
const schemeOverride = (process.env.EXPO_APP_SCHEME || process.env.HAPPY_STACKS_MOBILE_SCHEME || '').trim();
const resolvedScheme = schemeOverride || appEnvironmentConfig.scheme;

const mergeDeep = (base, override) => {
    if (override == null) return base;
    if (Array.isArray(base) || Array.isArray(override)) return override;
    if (typeof base !== 'object' || typeof override !== 'object') return override;

    const next = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        next[key] = Object.prototype.hasOwnProperty.call(base, key) ? mergeDeep(base[key], value) : value;
    }
    return next;
};

const withRequiredIosBackgroundAudio = (expoConfig) => {
    const plugins = Array.isArray(expoConfig.plugins) ? expoConfig.plugins : [];
    let found = false;
    const requiredPlugins = plugins.flatMap((plugin) => {
        const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
        if (pluginName !== 'react-native-audio-api') return [plugin];
        if (found) return [];
        found = true;
        const options = Array.isArray(plugin) && plugin[1] && typeof plugin[1] === 'object'
            ? plugin[1]
            : {};
        return [['react-native-audio-api', { ...options, iosBackgroundMode: true }]];
    });
    if (!found) {
        requiredPlugins.push(['react-native-audio-api', { iosBackgroundMode: true }]);
    }
    return { ...expoConfig, plugins: requiredPlugins };
};

const ANDROID_VOICE_FOREGROUND_SERVICE_PLUGIN = './plugins/withAndroidVoiceForegroundService.js';

const withRequiredAndroidVoiceForegroundService = (expoConfig) => {
    const plugins = Array.isArray(expoConfig.plugins) ? expoConfig.plugins : [];
    let found = false;
    const requiredPlugins = plugins.flatMap((plugin) => {
        const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
        if (pluginName !== ANDROID_VOICE_FOREGROUND_SERVICE_PLUGIN) return [plugin];
        if (found) return [];
        found = true;
        // Keep a local override's placement and any future plugin options.
        return [plugin];
    });
    if (!found) {
        requiredPlugins.push(ANDROID_VOICE_FOREGROUND_SERVICE_PLUGIN);
    }
    return { ...expoConfig, plugins: requiredPlugins };
};
const iosLiveActivitiesFrequentUpdates =
    parseOptionalBoolean(
        process.env.EXPO_PUBLIC_IOS_LIVE_ACTIVITIES_FREQUENT_UPDATES
            ?? process.env.EXPO_IOS_LIVE_ACTIVITIES_FREQUENT_UPDATES
    ) ?? false;
const iosLiveActivitiesPushNotifications =
    parseOptionalBoolean(
        process.env.EXPO_PUBLIC_IOS_LIVE_ACTIVITIES_PUSH_NOTIFICATIONS
            ?? process.env.EXPO_IOS_LIVE_ACTIVITIES_PUSH_NOTIFICATIONS
    ) ?? true;

function resolveIosLiveActivityApnsEnvironment() {
    const configured = String(
        process.env.EXPO_PUBLIC_HAPPIER_IOS_APNS_ENVIRONMENT
            ?? process.env.EXPO_IOS_APNS_ENVIRONMENT
            ?? ''
    ).trim().toLowerCase();
    if (configured === 'production') return 'production';
    if (configured === 'sandbox') return 'sandbox';
    return appIdentityVariant === 'production' ? 'production' : 'sandbox';
}

const iosLiveActivityApnsEnvironment = resolveIosLiveActivityApnsEnvironment();
const syncTuningJson = (
    process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON ||
    process.env.HAPPIER_SYNC_TUNING_JSON ||
    ''
).trim();

// Native model packs (Sherpa-ONNX) are download-on-demand. Expo "public" env vars are embedded
// at bundle time, so we provide a dev-safe default mapping that can be overridden in EAS/env.
//
// Override points:
// - EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (full JSON mapping)
// - EXPO_PUBLIC_HAPPIER_MODEL_PACKS_REPO + EXPO_PUBLIC_HAPPIER_MODEL_PACKS_TAG (convenience)
const defaultModelPacksRepo = (process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACKS_REPO || 'happier-dev/happier-assets').trim();
const defaultModelPacksTag = (process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACKS_TAG || 'model-packs').trim();
if (!process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS) {
    process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
        "kokoro-82m-v1.0-onnx-q8-wasm": `https://github.com/${defaultModelPacksRepo}/releases/download/${defaultModelPacksTag}/kokoro-82m-v1.0-onnx-q8-wasm__manifest.json`,
        "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17": `https://github.com/${defaultModelPacksRepo}/releases/download/${defaultModelPacksTag}/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17__manifest.json`
    });
}

const baseExpoConfig = {
        name,
        slug,
        version: versionOverride || packageJsonVersion || "0.1.0",
        runtimeVersion: explicitRuntimeVersion || resolveDefaultExpoRuntimeVersion(),
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: resolvedScheme,
        userInterfaceStyle: "automatic",
        notification: {
            icon: "./sources/assets/images/icon-notification.png",
            iosDisplayInForeground: true
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: iosBundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                // Required because we use on-device speech recognition (and some SDKs may reference it).
                // Apple requires a purpose string even if the code path is not exercised.
                NSSpeechRecognitionUsageDescription: "Allow $(PRODUCT_NAME) to convert your speech to text to enable voice conversations and transcription.",
                NSPhotoLibraryUsageDescription: "Allow $(PRODUCT_NAME) to access your photo library so you can pick and share photos with AI.",
                NSPhotoLibraryAddUsageDescription: "Allow $(PRODUCT_NAME) to save photos to your library when you choose to export or share.",
                NSLocationWhenInUseUsageDescription: "Allow $(PRODUCT_NAME) to access your location to improve AI responses and suggestions.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                NSAppTransportSecurity: {
                    NSAllowsLocalNetworking: true,
                    NSAllowsArbitraryLoads: false,
                },
            },
            associatedDomains: appEnvironmentConfig.enableAssociatedDomains ? iosAssociatedDomains : []
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                // Keep this path resolvable in repo checkouts; true monochrome art can be swapped in later.
                monochromeImage: "./sources/assets/images/icon-adaptive.png",
                backgroundColor: "#18171C"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION"
            ],
            edgeToEdgeEnabled: true,
            package: androidPackage,
            googleServicesFile: "./google-services.json",
            intentFilters: appEnvironmentConfig.enableAssociatedDomains ? [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": linkHost,
                            "pathPrefix": "/"
                        }
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                }
            ] : []
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        autolinking: optionalNativeAutolinkingConfig,
        plugins: [
            expoBuildPropertiesPlugin,
            require("./plugins/withEinkCompatibility.js"),
            require("./plugins/withAndroidReactNativeArchitectures.js"),
            require("./plugins/withReactNativeRepackRuntime.js"),
            ...(terminalNativeRendererEnabled ? ["./plugins/withTerminalNativeBuildInputs.js"] : []),
            require("./modules/happier-hardware-keyboard-shortcuts/app.plugin.js"),
            ...(androidReleaseShrinkerPlugin ? [androidReleaseShrinkerPlugin] : []),
            [
                "@sentry/react-native/expo",
                {
                    url: "https://sentry.io/",
                    project: "happier-ui",
                    organization: "happier-devs"
                }
            ],
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            ...(devClientLaunchMode ? [[
                "expo-dev-client",
                devClientPluginOptions
            ]] : devClientAddGeneratedScheme !== null ? [[
                "expo-dev-client",
                devClientPluginOptions
            ]] : []),
            "expo-updates",
            "expo-asset",
            "expo-localization",
            [
                "expo-widgets",
                {
                    bundleIdentifier: `${iosBundleId}.ExpoWidgetsTarget`,
                    frequentUpdates: iosLiveActivitiesFrequentUpdates,
                    enablePushNotifications: iosLiveActivitiesPushNotifications,
                    widgets: [
                        {
                            name: "HappierFocusWidget",
                            displayName: "Happier Focus",
                            description: "Shows the current focus session and quick actions at a glance.",
                            supportedFamilies: ["systemSmall", "systemMedium", "systemLarge", "accessoryRectangular"],
                        },
                        {
                            name: "HappierSessionsWidget",
                            displayName: "Happier Sessions",
                            description: "Shows multiple active sessions and their current attention state.",
                            supportedFamilies: ["systemSmall", "systemMedium", "systemLarge"],
                        },
                        {
                            name: "HappierFocusLiveActivity",
                            displayName: "Happier Focus Live",
                            description: "Shows the focused session on the Lock Screen and in the Dynamic Island.",
                            supportedFamilies: ["accessoryRectangular"],
                        },
                    ],
                }
            ],
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "react-native-enriched-markdown",
                {
                    enableMath: true
                }
            ],
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            "expo-speech-recognition",
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
            [
                "expo-image-picker",
                {
                    photosPermission: "Allow $(PRODUCT_NAME) to access your photo library so you can attach images."
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    sounds: [
                        "./sources/assets/sounds/happier_soft.wav",
                        "./sources/assets/sounds/happier_urgent.wav",
                    ]
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#F2F2F7",
                        dark: {
                            backgroundColor: "#1C1C1E",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#F5F5F5",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#1e1e1e",
                        }
                    }
                }
            ]
        ],
        updates: updatesConfig,
        ...(devClientSilentLaunch === true ? { developmentClient: { silentLaunch: true } } : {}),
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: { projectId: easProjectId },
            app: {
                // `variant` is used by the JS app runtime for environment-specific guidance and lanes.
                // Keep the native identity (`APP_ENV`) separate so we can ship preview-lane behavior to
                // production bundle IDs without disabling production-only native configuration.
                variant: appVariantOverride || appVariant,
                identityVariant: appIdentityVariant,
                happierLiveActivityApnsEnvironment: iosLiveActivityApnsEnvironment,
                iosLiveActivityPushNotificationsEnabled: iosLiveActivitiesPushNotifications,
                iosBackgroundWakeNotificationsEnabled: true,
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY || process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                ...(syncTuningJson ? { syncTuningJson } : {})
            }
        },
        owner
};

let localExpoOverrides = null;
if (typeof appLocalConfigModule === 'function') {
    localExpoOverrides = appLocalConfigModule({ variant: appVariant, baseConfig: { expo: baseExpoConfig } });
} else if (appLocalConfigModule && typeof appLocalConfigModule === 'object') {
    localExpoOverrides = appLocalConfigModule;
}
if (localExpoOverrides && typeof localExpoOverrides === 'object' && 'expo' in localExpoOverrides) {
    localExpoOverrides = localExpoOverrides.expo;
}

const mergedExpoConfig = localExpoOverrides && typeof localExpoOverrides === 'object'
    ? mergeDeep(baseExpoConfig, localExpoOverrides)
    : baseExpoConfig;

export default {
    // Voice's platform-required iOS audio and Android foreground-service
    // declarations must survive every supported local plugin override.
    expo: withRequiredAndroidVoiceForegroundService(
        withRequiredIosBackgroundAudio(mergedExpoConfig),
    ),
};
