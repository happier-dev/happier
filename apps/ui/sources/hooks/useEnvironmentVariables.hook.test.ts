import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/ops', () => {
    return {
        machinePreviewEnv: vi.fn(async () => {
            // Keep the request pending so the hook stays "loading".
            // This is a true system boundary (daemon RPC) so mocking is appropriate.
            await new Promise(() => {});
            return { supported: true, response: { values: {}, policy: 'redacted' } };
        }),
        machineBash: vi.fn(async () => {
            await new Promise(() => {});
            return { success: false, error: 'not used' };
        }),
    };
});

describe('useEnvironmentVariables (hook)', () => {
    it('sets isLoading=true before consumer useEffect can run', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        let latestIsLoading: boolean | null = null;

        function Test() {
            const res = useEnvironmentVariables('m1', ['OPENAI_API_KEY']);
            latestIsLoading = res.isLoading;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latestIsLoading).toBe(true);
    });

    it('returns empty non-loading state when machine id is missing', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        let latest: ReturnType<typeof useEnvironmentVariables> | null = null;
        function Test() {
            latest = useEnvironmentVariables(null, ['OPENAI_API_KEY']);
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.isLoading).toBe(false);
        expect(latest?.variables).toEqual({});
        expect(latest?.isPreviewEnvSupported).toBe(false);
    });

    it('finishes immediately when all variable names are invalid', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        let latest: ReturnType<typeof useEnvironmentVariables> | null = null;
        function Test() {
            latest = useEnvironmentVariables('m1', ['invalid-name', 'lowercase']);
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(3);
        });

        expect(latest?.isLoading).toBe(false);
        expect(latest?.variables).toEqual({});
        expect(latest?.meta).toEqual({});
    });
});
