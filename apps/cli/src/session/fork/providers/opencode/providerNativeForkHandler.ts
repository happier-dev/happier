import type { ProviderNativeForkHandler } from '@/session/fork/providerNativeForkHandler';

/**
 * OpenCode historically supported a native server-side fork path.
 *
 * During the extension cutover we keep the handler slot present (so the host registry
 * stays non-interpretive), but fail closed until the server-native fork implementation
 * is re-homed behind the extension runtime contract.
 */
export const openCodeProviderNativeForkHandler: ProviderNativeForkHandler = async () => {
    return null;
};
