import {
    defineLocalService,
    type LocalServiceDeclarationV1,
} from '../localServices.js';

// LEDGER DEC-6 (RN-WEB-LOADER): 'web' is a first-class dev-server platform —
// a reactNative-mode plugin's web (react-native-web/Vite) target gets the
// SAME dev-hot-reload binding shape as ios/android, just gated on a web dev
// server instead of a Re.Pack/Metro one. This was previously
// ios/android-only, which RN-ANALYSIS flagged as making web unrepresentable
// at the authoring-contract layer, not just at the runtime-gating layer.
type ReactNativeBundleDevServerPlatform = 'ios' | 'android' | 'web';

export type ReactNativeBundleDevServerBindingV1<TService extends LocalServiceDeclarationV1> = Readonly<{
    contributionId: string;
    platform: ReactNativeBundleDevServerPlatform;
    localService: TService;
    requiredFeatureId: 'plugins.ui.reactNativeBundles.devHotReload';
    devHotReload: Readonly<{
        kind: 'reactNativeBundleDevHotReload';
        localServiceId: string;
        platform: ReactNativeBundleDevServerPlatform;
    }>;
}>;

export function defineReactNativeBundleDevServer<const TService extends LocalServiceDeclarationV1>(
    input: Readonly<{
        contributionId: string;
        platform: ReactNativeBundleDevServerPlatform;
        service: TService;
    }>,
): ReactNativeBundleDevServerBindingV1<TService> {
    const localService = defineLocalService(input.service);
    return Object.freeze({
        contributionId: input.contributionId,
        platform: input.platform,
        localService,
        requiredFeatureId: 'plugins.ui.reactNativeBundles.devHotReload',
        devHotReload: Object.freeze({
            kind: 'reactNativeBundleDevHotReload',
            localServiceId: localService.id,
            platform: input.platform,
        }),
    });
}
