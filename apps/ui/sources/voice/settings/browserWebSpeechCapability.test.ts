import { describe, expect, it, vi } from 'vitest';

import { probeBrowserWebSpeechCapability } from './browserWebSpeechCapability';

type SpeechRecognitionConstructorStub = {
    new(): { processLocally?: boolean };
    available?: (options: unknown) => Promise<unknown>;
    install?: (options: unknown) => Promise<unknown>;
};

function createSpeechRecognitionConstructor(input: Readonly<{
    hasProcessLocally?: boolean;
    available?: (options: unknown) => Promise<unknown>;
    install?: (options: unknown) => Promise<unknown>;
}> = {}): SpeechRecognitionConstructorStub {
    function SpeechRecognition(this: { processLocally?: boolean }) {
        if (input.hasProcessLocally !== false) {
            this.processLocally = false;
        }
    }
    if (input.hasProcessLocally !== false) {
        SpeechRecognition.prototype.processLocally = false;
    }
    const constructor = SpeechRecognition as unknown as SpeechRecognitionConstructorStub;
    if (input.available) {
        constructor.available = input.available;
    }
    if (input.install) {
        constructor.install = input.install;
    }
    return constructor;
}

describe('probeBrowserWebSpeechCapability', () => {
    it('fails closed when the browser SpeechRecognition constructor is absent', async () => {
        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {},
        })).resolves.toEqual({
            support: 'unavailable',
            onDevice: 'unsupported',
        });
    });

    it('treats browser speech without on-device static APIs as cloud-only', async () => {
        const install = vi.fn();

        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({ install }),
                navigator: { language: 'en-US' },
            },
        })).resolves.toEqual({
            support: 'cloud_only',
            onDevice: 'unsupported',
        });
        expect(install).not.toHaveBeenCalled();
    });

    it('reports on-device availability through SpeechRecognition.available without installing packs', async () => {
        const available = vi.fn().mockResolvedValue('available');
        const install = vi.fn();

        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({ available, install }),
                navigator: { languages: ['en-US', 'fr-FR'] },
            },
        })).resolves.toEqual({
            support: 'available',
            onDevice: 'available',
        });
        expect(available).toHaveBeenCalledWith({ langs: ['en-US', 'fr-FR'], processLocally: true });
        expect(install).not.toHaveBeenCalled();
    });

    it.each([
        ['downloadable'],
        ['downloading'],
    ] as const)('keeps cloud fallback explicit when on-device speech packs are %s', async (status) => {
        const install = vi.fn();

        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({
                    available: vi.fn().mockResolvedValue(status),
                    install,
                }),
                navigator: { language: 'en-US' },
            },
        })).resolves.toEqual({
            support: 'cloud_only',
            onDevice: status,
        });
        expect(install).not.toHaveBeenCalled();
    });

    it('distinguishes on-device Permissions-Policy blocking from unsupported browser speech', async () => {
        const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });

        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({
                    available: vi.fn().mockRejectedValue(blocked),
                }),
                navigator: { language: 'en-US' },
            },
        })).resolves.toEqual({
            support: 'cloud_only',
            onDevice: 'permission_policy_blocked',
        });
    });

    it('fails closed when the on-device availability probe throws an unexpected error', async () => {
        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({
                    available: vi.fn().mockRejectedValue(new Error('probe failed')),
                }),
                navigator: { language: 'en-US' },
            },
        })).resolves.toEqual({
            support: 'unknown',
            onDevice: 'unknown',
        });
    });

    it('fails closed when the on-device availability probe returns a malformed value', async () => {
        await expect(probeBrowserWebSpeechCapability({
            platformOs: 'web',
            globalObject: {
                SpeechRecognition: createSpeechRecognitionConstructor({
                    available: vi.fn().mockResolvedValue({ status: 'available' }),
                }),
                navigator: { language: 'en-US' },
            },
        })).resolves.toEqual({
            support: 'unknown',
            onDevice: 'unknown',
        });
    });
});
