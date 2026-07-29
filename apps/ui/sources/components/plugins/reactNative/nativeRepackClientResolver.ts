import { Platform } from 'react-native';

const REPACK_CLIENT_PACKAGE_NAME = '@callstack/repack/client';

declare const require: undefined | ((moduleName: string) => unknown);

export type DefaultNativeRepackClientResolverOptions = Readonly<{
    platformOS?: string;
    nodeEnv?: string;
    requireClient?: (moduleName: string) => unknown;
}>;

function isNativePlatform(platformOS: string | undefined): boolean {
    return platformOS === 'ios' || platformOS === 'android';
}

function requireRepackClientPackage(): unknown {
    if (typeof require !== 'function') {
        return null;
    }
    try {
        return require('@callstack/repack/client');
    } catch {
        return null;
    }
}

export function resolveDefaultNativeRepackClient(
    options?: DefaultNativeRepackClientResolverOptions,
): unknown {
    const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
    if (nodeEnv === 'test') {
        return null;
    }

    const platformOS = options?.platformOS ?? Platform.OS;
    if (!isNativePlatform(platformOS)) {
        return null;
    }

    return (options?.requireClient ?? requireRepackClientPackage)(REPACK_CLIENT_PACKAGE_NAME);
}
