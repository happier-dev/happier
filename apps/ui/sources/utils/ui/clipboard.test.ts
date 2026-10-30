import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.doMock('react-native', async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// Browser APIs are the external boundary; the clipboard owner and its UI result stay real.
function installBrowserClipboard(writeText: ((value: string) => Promise<void>) | undefined, legacyCopied = false) {
    const textField = { value: '', select: vi.fn() };
    const execCommand = vi.fn(() => legacyCopied);
    const removeChild = vi.fn();
    vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined });
    vi.stubGlobal('document', {
        createElement: vi.fn(() => textField),
        body: { appendChild: vi.fn(), removeChild },
        execCommand,
    });
    return { textField, execCommand, removeChild };
}

describe('writeClipboardStringFromUi web gesture', () => {
    it.each([true, false])('starts the platform write synchronously and reports copied=%s', async copied => {
        vi.resetModules();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Expo 55.0.11 can report true even when both browser writes were refused.
        const setStringAsync = vi.fn(async () => true);
        const writeText = vi.fn(async (_text: string) => {
            if (!copied) throw new DOMException('', 'NotAllowedError');
        });
        const browser = installBrowserClipboard(writeText);
        vi.doMock('expo-clipboard', () => ({ setStringAsync }));
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        });
        const { writeClipboardStringFromUi } = await import('./clipboard');
        const execute = vi.fn(async () => { throw new Error('Web gesture entered async Action admission'); });
        const result = writeClipboardStringFromUi('/repo/fix270', execute);
        expect(writeText.mock.calls).toEqual([['/repo/fix270']]);
        expect(setStringAsync).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        await expect(result).resolves.toEqual(copied
            ? { ok: true, result: { status: 'copied' } }
            : { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' });
        expect(browser.execCommand.mock.calls).toEqual(copied ? [] : [['copy']]);
    });
});

describe('web clipboard platform outcomes', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        });
        vi.doMock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
    });

    it('refuses an optimistic Expo boolean when both platform writes fail', async () => {
        const browser = installBrowserClipboard(vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError')));
        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('sentinel')).resolves.toBe(false);
        expect(browser.textField.value).toBe('sentinel');
        expect(browser.removeChild).toHaveBeenCalledWith(browser.textField);
    });

    it.each([true, false])('uses the legacy platform outcome when the modern API is absent: %s', async copied => {
        const browser = installBrowserClipboard(undefined, copied);
        const { setClipboardStringSafe } = await import('./clipboard');
        const result = setClipboardStringSafe('sentinel');
        expect(browser.execCommand).toHaveBeenCalledWith('copy');
        await expect(result).resolves.toBe(copied);
        expect(browser.removeChild).toHaveBeenCalledWith(browser.textField);
    });

    it('reports copied after a refused modern write only if the legacy write succeeds', async () => {
        const browser = installBrowserClipboard(vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError')), true);
        const { writeClipboardStringFromUi } = await import('./clipboard');
        const execute = vi.fn(async () => { throw new Error('native admission must not run on web'); });
        await expect(writeClipboardStringFromUi('sentinel', execute)).resolves.toEqual({ ok: true, result: { status: 'copied' } });
        expect(browser.execCommand).toHaveBeenCalledWith('copy');
        expect(execute).not.toHaveBeenCalled();
    });

    it('removes the fallback field and reports unavailable when the legacy API throws', async () => {
        const browser = installBrowserClipboard(undefined);
        browser.execCommand.mockImplementation(() => { throw new DOMException('', 'NotAllowedError'); });
        const { writeClipboardStringFromUi } = await import('./clipboard');
        await expect(writeClipboardStringFromUi('sentinel', vi.fn())).resolves.toMatchObject({
            ok: false, errorCode: 'clipboard_unavailable',
        });
        expect(browser.removeChild).toHaveBeenCalledWith(browser.textField);
    });
});

describe('getClipboardStringTrimmedSafe', () => {
    it('preserves the raw clipboard value when the host must distinguish a failed read', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => ({
            getStringAsync: vi.fn(async () => '  review link  '),
        }));

        const { getClipboardStringSafe } = await import('./clipboard');
        await expect(getClipboardStringSafe()).resolves.toBe('  review link  ');
    });

    it('returns trimmed clipboard contents', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => '  hello  '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('hello');
    });

    it('returns empty string when clipboard read throws', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });

    it('returns empty string when clipboard contents are whitespace only', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => ' \n\t '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });
});

describe('setClipboardStringSafe', () => {
    it('writes to clipboard and returns true', async () => {
        vi.resetModules();
        const setStringAsync = vi.fn(async () => true);
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync,
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(true);
        expect(setStringAsync).toHaveBeenCalledWith('hello');
    });

    it('returns false when clipboard write throws', async () => {
        vi.resetModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(false);
        expect(warning).toHaveBeenCalled();
        expect(warning.mock.calls.flat()).not.toContain('hello');
    });

    it('returns false when the platform declines a clipboard write', async () => {
        vi.resetModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.doMock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => false) }));

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(false);
        expect(warning).toHaveBeenCalled();
        expect(warning.mock.calls.flat()).not.toContain('hello');
    });
});
