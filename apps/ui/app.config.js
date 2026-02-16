const variant = process.env.APP_ENV || 'development';

const DEFAULTS = {
    owner: "happier-dev",
    slug: "happier",
    scheme: "happier",
    iosBundleId: "dev.happier.app",
    easProjectId: "2a550bd7-e4d2-4f59-ab47-dcb778775cee",
    updatesChannel: "production",
    linkHost: "app.happier.dev",
};

// Allow opt-in overrides for local dev tooling without changing upstream defaults.
const nameOverride = (process.env.EXPO_APP_NAME || process.env.HAPPY_STACKS_IOS_APP_NAME || '').trim();
const bundleIdOverride = (process.env.EXPO_APP_BUNDLE_ID || process.env.HAPPY_STACKS_IOS_BUNDLE_ID || '').trim();
const ownerOverride = (process.env.EXPO_APP_OWNER || '').trim();
const slugOverride = (process.env.EXPO_APP_SLUG || '').trim();

const namesByVariant = {
    development: "Happier (dev)",
    preview: "Happier (preview)",
    production: "Happier"
};
const bundleIdsByVariant = {
    development: "dev.happier.app.dev",
    preview: "dev.happier.app.preview",
    production: DEFAULTS.iosBundleId
};
const appVariant = namesByVariant[variant] ? variant : 'development';

// If APP_ENV is unknown, fall back to development-safe defaults to avoid generating
// an invalid Expo config with undefined name/bundle id.
const name = nameOverride || namesByVariant[appVariant] || namesByVariant.development;
const bundleId = bundleIdOverride || bundleIdsByVariant[appVariant] || bundleIdsByVariant.development;
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

const updatesUrl = (process.env.EXPO_UPDATES_URL || '').trim() || `https://u.expo.dev/${easProjectId}`;
const updatesChannel = (process.env.EXPO_UPDATES_CHANNEL || '').trim() || (appVariant === 'production' ? DEFAULTS.updatesChannel : appVariant);
const updatesConfig = {
    url: updatesUrl,
    requestHeaders: {
        "expo-channel-name": updatesChannel
    }
};

const linkHost = (process.env.EXPO_APP_LINK_HOST || DEFAULTS.linkHost).trim();
const iosAssociatedDomainsRaw = (process.env.EXPO_IOS_ASSOCIATED_DOMAINS || '').trim();
const iosAssociatedDomains = iosAssociatedDomainsRaw
    ? iosAssociatedDomainsRaw.split(/[\s,]+/).map(v => v.trim()).filter(Boolean)
    : [`applinks:${linkHost}`];

// NOTE:
// The URL scheme is used for deep linking *and* by the Expo development client launcher flow.
// Keep the default stable for upstream users, but allow opt-in overrides for local dev variants
// (e.g. to avoid iOS scheme collisions between multiple installs).
const scheme = (process.env.EXPO_APP_SCHEME || process.env.HAPPY_STACKS_MOBILE_SCHEME || '').trim() || DEFAULTS.scheme;

const parseOptionalBoolean = (raw) => {
    const value = (raw ?? '').toString().trim().toLowerCase();
    if (!value) return null;
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
    return null;
};

// iOS background audio is required for "call-like" realtime ElevenLabs sessions to keep working when the app is
// backgrounded/locked. We enable this by default for all variants so dev-client testing matches production behavior.
const iosBackgroundAudioOverride = parseOptionalBoolean(
    process.env.EXPO_PUBLIC_IOS_BACKGROUND_AUDIO ?? process.env.EXPO_IOS_BACKGROUND_AUDIO
);
const iosBackgroundAudioEnabled = iosBackgroundAudioOverride ?? true;

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

export default {
    expo: {
        name,
        slug,
        version: "0.1.0",
        runtimeVersion: "18",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme,
        userInterfaceStyle: "automatic",
        newArchEnabled: true,
        notification: {
            icon: "./sources/assets/images/icon-notification.png",
            iosDisplayInForeground: true
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                // Required because we use on-device speech recognition (and some SDKs may reference it).
                // Apple requires a purpose string even if the code path is not exercised.
                NSSpeechRecognitionUsageDescription: "Allow $(PRODUCT_NAME) to convert your speech to text to enable voice conversations and transcription.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                NSAppTransportSecurity: {
                    NSAllowsLocalNetworking: true,
                    NSAllowsArbitraryLoads: false,
                },
            },
            associatedDomains: appVariant === 'production' ? iosAssociatedDomains : []
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
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
            package: bundleId,
            googleServicesFile: "./google-services.json",
            intentFilters: appVariant === 'production' ? [
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
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            [
                "react-native-audio-api",
                {
                    // Enables UIBackgroundModes=audio when true (required for realtime voice calls in background).
                    iosBackgroundMode: iosBackgroundAudioEnabled
                }
            ],
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true
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
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: { projectId: easProjectId },
            app: {
                variant: appVariant,
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE
            }
        },
        owner
    }
};
