import { afterEach, describe, expect, it, vi } from 'vitest';

import { __testables } from './uiWebMetro';

const fetchSpy = vi.fn();

describe('uiWebMetro status readiness', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        fetchSpy.mockReset();
    });

    it('requires the Metro /status body to report packager-status:running', async () => {
        const isMetroPackagerReady = (__testables as unknown as {
            isMetroPackagerReady?: (baseUrl: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
        }).isMetroPackagerReady;

        expect(typeof isMetroPackagerReady).toBe('function');

        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async () => ({
            ok: true,
            headers: { get: () => 'text/plain' },
            text: async () => 'packager-status:booting',
        } as unknown as Response)));

        await expect(isMetroPackagerReady!('http://localhost:19077', {
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        })).resolves.toBe(false);
        expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('accepts a 200 Metro status response when Metro-identifying headers arrive before the body resolves', async () => {
        const isMetroPackagerReady = (__testables as unknown as {
            isMetroPackagerReady?: (baseUrl: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
        }).isMetroPackagerReady;

        expect(typeof isMetroPackagerReady).toBe('function');

        vi.stubGlobal('fetch', fetchSpy.mockImplementation(async () => ({
            ok: true,
            headers: {
                get: (name: string) => name.toLowerCase() === 'x-react-native-project-root' ? '/tmp/happier-ui' : null,
            },
            text: async () => {
                throw new DOMException('The operation was aborted.', 'AbortError');
            },
        } as unknown as Response)));

        await expect(isMetroPackagerReady!('http://localhost:19077', {
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        })).resolves.toBe(true);
        expect(fetchSpy).toHaveBeenCalledOnce();
    });
});
