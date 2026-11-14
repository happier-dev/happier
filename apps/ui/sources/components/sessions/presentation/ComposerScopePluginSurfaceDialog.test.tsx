import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PluginHostedWebUnavailable } from '@/components/plugins/hostedWeb/PluginHostedWebUnavailable';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal/types';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { ComposerScopePluginSurfaceDialog } from './ComposerScopePluginSurfaceDialog';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('ComposerScopePluginSurfaceDialog', () => {
    it.each([
        { failure: 'renderer', layout: 'content' },
        { failure: 'renderer', layout: 'list' },
        { failure: 'renderer', layout: 'split' },
        { failure: 'admission', layout: 'content' },
        { failure: 'hosted', layout: 'content' },
    ] as const)(
        'uses the $failure refusal heading in $layout and restores the attachment title after recovery',
        async ({ failure, layout }) => {
            // A legitimate PostHog issue title must remain intact when its picker is healthy.
            const attachmentTitle = "Cannot read properties of undefined (reading 'id')";
            const published: { chrome: CustomModalChromeConfig | null } = { chrome: null };
            const setChrome = (next: CustomModalChromeConfig | null) => { published.chrome = next; };
            const chromeTitle = () => published.chrome?.kind === 'card' ? published.chrome.title : null;
            let setUnavailable: React.Dispatch<React.SetStateAction<boolean>> = () => {};
            const reasonCode = 'artifact_bytes_rpc_unavailable';
            const expectedTitle = resolvePluginSurfaceStatePresentation({
                state: failure === 'renderer' ? 'failedRetry' : 'unavailable',
                reasonCode,
                ...(failure === 'renderer' ? { title: t('pluginReactNative.unavailable') }
                    : failure === 'hosted' ? { title: t('pluginRuntime.hostedWebUnavailableTitle') } : {}),
            }).card?.title;

            function Refusal(): React.ReactElement {
                return failure === 'renderer'
                    ? <PluginReactNativeUnavailable diagnostics={[reasonCode]} onRetry={() => {}} />
                    : failure === 'hosted'
                        ? <PluginHostedWebUnavailable diagnosticCode={reasonCode} />
                        : <PluginSurfaceFallback testID="picker-refusal" reasonCode={reasonCode} />;
            }

            function Picker(): React.ReactElement {
                const [unavailable, updateUnavailable] = React.useState(false);
                setUnavailable = updateUnavailable;
                return (
                    <ComposerScopePluginSurfaceDialog title={attachmentTitle} layout={layout} setChrome={setChrome} onClose={() => {}}>
                        {unavailable ? <Refusal /> : null}
                    </ComposerScopePluginSurfaceDialog>
                );
            }

            await renderScreen(<Picker />);
            expect(chromeTitle()).toBe(attachmentTitle);
            await act(async () => { setUnavailable(true); });
            expect(chromeTitle()).toBe(expectedTitle);
            expect(chromeTitle()).not.toBe(attachmentTitle);
            await act(async () => { setUnavailable(false); });
            expect(chromeTitle()).toBe(attachmentTitle);
        },
    );
});
