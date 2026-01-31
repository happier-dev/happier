const variant = process.env.APP_ENV || 'development';

// Allow opt-in overrides for local dev tooling without changing upstream defaults.
const nameOverride = (process.env.EXPO_APP_NAME || '').trim();
const bundleIdOverride = (process.env.EXPO_APP_BUNDLE_ID || '').trim();
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
    production: "dev.happier.app"
};

// If APP_ENV is unknown, fall back to development-safe defaults to avoid generating
// an invalid Expo config with undefined name/bundle id.
const name = nameOverride || namesByVariant[variant] || namesByVariant.development;
const bundleId = bundleIdOverride || bundleIdsByVariant[variant] || bundleIdsByVariant.development;
const owner = ownerOverride || "happier-dev";
const slug = slugOverride || "happier";

// IMPORTANT:
// Expo Updates uses a project-scoped UUID (EAS project id). Since you're migrating to a new Expo org,
// you should create/link a new EAS project and set this value (via env or by hard-coding it here).
const easProjectId =
    (process.env.EXPO_PUBLIC_EAS_PROJECT_ID || process.env.EAS_PROJECT_ID || '').trim();
const updatesConfig = easProjectId
    ? {
        url: `https://u.expo.dev/${easProjectId}`,
        requestHeaders: {
            "expo-channel-name": "production"
        }
    }
    : undefined;
// NOTE:
// The URL scheme is used for deep linking *and* by the Expo development client launcher flow.
// Keep the default stable for upstream users, but allow opt-in overrides for local dev variants
// (e.g. to avoid iOS scheme collisions between multiple installs).
const scheme = (process.env.EXPO_APP_SCHEME || '').trim() || "happier";

export default {
    expo: {
        name,
        slug,
        version: "1.6.2",
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
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"]
            },
            associatedDomains: variant === 'production' ? ["applinks:app.happier.dev"] : []
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
            intentFilters: variant === 'production' ? [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": "app.happier.dev",
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
            "react-native-audio-api",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-location",
                {
                    locationAlwaysAndWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationAlwaysPermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location."
                }
            ],
            [
                "expo-calendar",
                {
                    "calendarPermission": "Allow $(PRODUCT_NAME) to access your calendar to improve AI quality."
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
        ...(updatesConfig ? { updates: updatesConfig } : {}),
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
            app: {
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE
            }
        },
        owner
    }
};
