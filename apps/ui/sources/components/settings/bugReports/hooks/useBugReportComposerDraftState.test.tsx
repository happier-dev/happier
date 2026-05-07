import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installBugReportHooksCommonModuleMocks();

describe('useBugReportComposerDraftState', () => {
    it('updates untouched server environment defaults when the active server changes', async () => {
        const { useBugReportComposerDraftState } = await import('./useBugReportComposerDraftState');

        const hook = await renderHook(
            ({ serverUrlDefault }: { serverUrlDefault: string }) => useBugReportComposerDraftState({
                profile: null,
                serverUrlDefault,
            }),
            {
                initialProps: { serverUrlDefault: 'http://self-hosted.example.test' },
            },
        );

        expect(hook.getCurrent().serverUrl).toBe('http://self-hosted.example.test');
        expect(hook.getCurrent().deploymentType).toBe('self-hosted');

        await hook.rerender({ serverUrlDefault: 'https://app.happier.dev' });

        expect(hook.getCurrent().serverUrl).toBe('https://app.happier.dev');
        expect(hook.getCurrent().deploymentType).toBe('cloud');
    });

    it('does not overwrite manually edited server environment fields when the active server changes', async () => {
        const { useBugReportComposerDraftState } = await import('./useBugReportComposerDraftState');

        const hook = await renderHook(
            ({ serverUrlDefault }: { serverUrlDefault: string }) => useBugReportComposerDraftState({
                profile: null,
                serverUrlDefault,
            }),
            {
                initialProps: { serverUrlDefault: 'http://self-hosted.example.test' },
            },
        );

        await act(async () => {
            hook.getCurrent().setServerUrl('https://corp.internal');
            hook.getCurrent().setDeploymentType('enterprise');
        });
        await flushHookEffects();

        await hook.rerender({ serverUrlDefault: 'https://app.happier.dev' });

        expect(hook.getCurrent().serverUrl).toBe('https://corp.internal');
        expect(hook.getCurrent().deploymentType).toBe('enterprise');
    });
});
