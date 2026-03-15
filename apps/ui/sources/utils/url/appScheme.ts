import Constants from 'expo-constants';

export function resolveAppUrlScheme(): string {
    const scheme = Constants.expoConfig?.scheme;

    if (typeof scheme === 'string') {
        const value = scheme.trim();
        if (value) return value;
    }

    if (Array.isArray(scheme)) {
        for (const entry of scheme) {
            if (typeof entry !== 'string') continue;
            const value = entry.trim();
            if (value) return value;
        }
    }

    return 'happier';
}

export function resolveAppUrlProtocol(): string {
    return `${resolveAppUrlScheme()}:`;
}
