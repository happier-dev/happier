import * as React from 'react';
import { Platform } from 'react-native';

import type {
    VoiceBrowserSpeechCapability,
    VoiceBrowserSpeechOnDeviceAvailability,
} from './resolveVoiceProviderAvailability';

type SpeechRecognitionInstance = {
    processLocally?: boolean;
};

type SpeechRecognitionConstructorLike = {
    new(): SpeechRecognitionInstance;
    available?: (options: Readonly<{ langs: readonly string[]; processLocally: true }>) => Promise<unknown> | unknown;
};

type BrowserWebSpeechGlobal = Readonly<{
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
    navigator?: Readonly<{
        language?: unknown;
        languages?: unknown;
    }>;
}>;

const WEB_SPEECH_UNKNOWN_CAPABILITY: VoiceBrowserSpeechCapability = {
    support: 'unknown',
    onDevice: 'unknown',
};

const WEB_SPEECH_UNSUPPORTED_CAPABILITY: VoiceBrowserSpeechCapability = {
    support: 'unavailable',
    onDevice: 'unsupported',
};

const WEB_SPEECH_CLOUD_ONLY_CAPABILITY: VoiceBrowserSpeechCapability = {
    support: 'cloud_only',
    onDevice: 'unsupported',
};

export function getDefaultBrowserWebSpeechCapability(platformOs: string = Platform.OS): VoiceBrowserSpeechCapability {
    return platformOs === 'web' ? WEB_SPEECH_UNKNOWN_CAPABILITY : WEB_SPEECH_UNSUPPORTED_CAPABILITY;
}

function isSpeechRecognitionConstructor(value: unknown): value is SpeechRecognitionConstructorLike {
    return typeof value === 'function';
}

function resolveSpeechRecognitionConstructor(
    globalObject: BrowserWebSpeechGlobal,
): SpeechRecognitionConstructorLike | null {
    if (isSpeechRecognitionConstructor(globalObject.SpeechRecognition)) {
        return globalObject.SpeechRecognition;
    }
    if (isSpeechRecognitionConstructor(globalObject.webkitSpeechRecognition)) {
        return globalObject.webkitSpeechRecognition;
    }
    return null;
}

function supportsProcessLocally(constructor: SpeechRecognitionConstructorLike): boolean {
    try {
        const recognition = new constructor();
        return 'processLocally' in recognition || 'processLocally' in constructor.prototype;
    } catch {
        return false;
    }
}

function readBrowserLanguages(globalObject: BrowserWebSpeechGlobal): readonly string[] {
    const navigatorLanguages = globalObject.navigator?.languages;
    if (Array.isArray(navigatorLanguages)) {
        const normalized = navigatorLanguages
            .filter((language): language is string => typeof language === 'string' && language.trim().length > 0)
            .map((language) => language.trim());
        if (normalized.length > 0) {
            return Array.from(new Set(normalized));
        }
    }

    const language = globalObject.navigator?.language;
    return typeof language === 'string' && language.trim().length > 0 ? [language.trim()] : ['en-US'];
}

function mapOnDeviceAvailability(status: VoiceBrowserSpeechOnDeviceAvailability): VoiceBrowserSpeechCapability {
    if (status === 'available') {
        return {
            support: 'available',
            onDevice: 'available',
        };
    }
    if (status === 'downloadable' || status === 'downloading' || status === 'unavailable') {
        return {
            support: 'cloud_only',
            onDevice: status,
        };
    }
    return WEB_SPEECH_UNKNOWN_CAPABILITY;
}

function parseOnDeviceAvailability(value: unknown): VoiceBrowserSpeechOnDeviceAvailability | null {
    return value === 'available'
        || value === 'downloadable'
        || value === 'downloading'
        || value === 'unavailable'
        ? value
        : null;
}

function isPermissionPolicyBlock(error: unknown): boolean {
    if (error === null || typeof error !== 'object') {
        return false;
    }
    const name = 'name' in error ? error.name : null;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return true;
    }
    const message = 'message' in error ? error.message : null;
    return typeof message === 'string' && /permissions?-policy|on-device-speech-recognition/i.test(message);
}

export async function probeBrowserWebSpeechCapability(input: Readonly<{
    platformOs?: string;
    globalObject?: BrowserWebSpeechGlobal;
}> = {}): Promise<VoiceBrowserSpeechCapability> {
    const platformOs = input.platformOs ?? Platform.OS;
    if (platformOs !== 'web') {
        return WEB_SPEECH_UNSUPPORTED_CAPABILITY;
    }

    const globalObject = input.globalObject ?? globalThis;
    const constructor = resolveSpeechRecognitionConstructor(globalObject);
    if (!constructor) {
        return WEB_SPEECH_UNSUPPORTED_CAPABILITY;
    }

    if (!('available' in constructor)) {
        return WEB_SPEECH_CLOUD_ONLY_CAPABILITY;
    }
    if (typeof constructor.available !== 'function' || !supportsProcessLocally(constructor)) {
        return WEB_SPEECH_UNKNOWN_CAPABILITY;
    }

    try {
        const status = parseOnDeviceAvailability(await constructor.available({
            langs: readBrowserLanguages(globalObject),
            processLocally: true,
        }));
        return status ? mapOnDeviceAvailability(status) : WEB_SPEECH_UNKNOWN_CAPABILITY;
    } catch (error) {
        if (isPermissionPolicyBlock(error)) {
            return {
                support: 'cloud_only',
                onDevice: 'permission_policy_blocked',
            };
        }
        return WEB_SPEECH_UNKNOWN_CAPABILITY;
    }
}

export function useBrowserWebSpeechCapability(platformOs: string = Platform.OS): VoiceBrowserSpeechCapability {
    const [capability, setCapability] = React.useState<VoiceBrowserSpeechCapability>(
        () => getDefaultBrowserWebSpeechCapability(platformOs),
    );

    React.useEffect(() => {
        const defaultCapability = getDefaultBrowserWebSpeechCapability(platformOs);
        setCapability(defaultCapability);
        if (platformOs !== 'web') {
            return undefined;
        }

        let cancelled = false;
        void probeBrowserWebSpeechCapability({ platformOs })
            .then((nextCapability) => {
                if (!cancelled) {
                    setCapability(nextCapability);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [platformOs]);

    return capability;
}
