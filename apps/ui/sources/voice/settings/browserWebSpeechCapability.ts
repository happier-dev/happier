import * as React from 'react';
import { Platform } from 'react-native';

import type { VoiceBrowserSpeechCapability } from './resolveVoiceProviderAvailability';

type SpeechRecognitionConstructorLike = Function & Readonly<{
    prototype: object;
    available?: unknown;
}>;

type BrowserWebSpeechGlobal = Readonly<{
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
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

function exposesProcessLocallyOnPrototype(constructor: SpeechRecognitionConstructorLike): boolean {
    try {
        return 'processLocally' in constructor.prototype;
    } catch {
        return false;
    }
}

function readPassiveBrowserWebSpeechCapability(input: Readonly<{
    platformOs?: string;
    globalObject?: BrowserWebSpeechGlobal;
}> = {}): VoiceBrowserSpeechCapability {
    const platformOs = input.platformOs ?? Platform.OS;
    if (platformOs !== 'web') {
        return WEB_SPEECH_UNSUPPORTED_CAPABILITY;
    }

    const globalObject = input.globalObject ?? {
        SpeechRecognition: Reflect.get(globalThis, 'SpeechRecognition'),
        webkitSpeechRecognition: Reflect.get(globalThis, 'webkitSpeechRecognition'),
    };
    const constructor = resolveSpeechRecognitionConstructor(globalObject);
    if (!constructor) {
        return WEB_SPEECH_UNSUPPORTED_CAPABILITY;
    }
    if (!('available' in constructor)) {
        return WEB_SPEECH_CLOUD_ONLY_CAPABILITY;
    }
    if (typeof constructor.available !== 'function' || !exposesProcessLocallyOnPrototype(constructor)) {
        return WEB_SPEECH_UNKNOWN_CAPABILITY;
    }
    return {
        support: 'cloud_only',
        onDevice: 'unknown',
    };
}

export function useBrowserWebSpeechCapability(platformOs: string = Platform.OS): VoiceBrowserSpeechCapability {
    // Settings render is passive: invoking the experimental `available()` API here can
    // block Chromium's navigation task.
    return React.useMemo(
        () => readPassiveBrowserWebSpeechCapability({ platformOs }),
        [platformOs],
    );
}
