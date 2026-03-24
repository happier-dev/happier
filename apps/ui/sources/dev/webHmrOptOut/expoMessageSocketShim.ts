import { installWebHmrOptOutForCurrentWebTab } from './webHmrOptOut';

type MessageSocketLoaders = {
    loadMessageSocket: () => unknown;
};

declare const require: (id: string) => unknown;

const defaultLoaders: MessageSocketLoaders = {
    loadMessageSocket: () => require('expo/src/async-require/messageSocket'),
};

export function runExpoMessageSocketShim({
    isDev,
    hasWindow,
    optOut,
    loaders = defaultLoaders,
}: {
    isDev: boolean;
    hasWindow: boolean;
    optOut: boolean;
    loaders?: MessageSocketLoaders;
}): void {
    if (!isDev || !hasWindow || optOut) {
        return;
    }

    loaders.loadMessageSocket();
}

runExpoMessageSocketShim({
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
    hasWindow: typeof window !== 'undefined',
    optOut:
        (typeof __DEV__ !== 'undefined' ? __DEV__ : false) &&
        typeof window !== 'undefined'
            ? installWebHmrOptOutForCurrentWebTab()
            : globalThis.__HAPPIER_WEB_HMR_OPT_OUT__ === true,
});
