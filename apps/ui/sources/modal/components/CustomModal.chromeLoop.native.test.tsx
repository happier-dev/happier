import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';
import { useModalCardChrome } from './card/useModalCardChrome';
import type { CustomModalInjectedProps } from '../types';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// The production signature in HAPPIER-UI-4 is the native layout-effect publish path
// (`commitLayoutEffectOnFiber` → `useModalCardChrome` → `setChrome` → `setChromeOverride`),
// so this harness runs the modal host on the native platform branch.
installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 1200, height: 760 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children, ...props }: any) => React.createElement('BaseModal', props, children),
}));

let unstableChromeRenderCount = 0;

// A runaway publish cycle would otherwise spin until React's own nested-update limit, so the
// harness stops it early and reports the re-entry instead of hanging the suite.
const CONTENT_RENDER_BUDGET = 8;

/**
 * Mirrors a real chrome consumer whose chrome memo depends on a value that is a fresh
 * identity on every render (a store-returned callback, a selector result, a themed style
 * object). Chrome memoization is the only thing that terminated the publish cycle, so an
 * unstable dependency turns the publish into a runaway.
 */
function UnstableDependencyChromeModal(props: CustomModalInjectedProps) {
    unstableChromeRenderCount += 1;
    if (unstableChromeRenderCount > CONTENT_RENDER_BUDGET) {
        throw new Error(
            `chrome publication re-entered the modal content: ${unstableChromeRenderCount} renders`,
        );
    }
    const unstableRefresh = () => {};
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: 'Detected CLIs',
        actions: React.createElement('RefreshAction', { onPress: unstableRefresh }),
    }), [unstableRefresh]));
    return React.createElement('UnstableDependencyChromeModal');
}

describe('CustomModal chrome publication cycle', () => {
    it('does not re-render the modal content when applying published chrome', async () => {
        unstableChromeRenderCount = 0;
        const { CustomModal } = await import('./CustomModal');

        await renderScreen(React.createElement(CustomModal, {
            config: {
                id: 'test-modal',
                type: 'custom' as const,
                component: UnstableDependencyChromeModal,
                props: {},
            },
            onClose: vi.fn(),
            visible: true,
        }));

        // The content mounts once, and once more when the null → card chrome transition
        // moves it inside the card frame. Applying chrome must not re-render it again,
        // otherwise the consumer republishes and the cycle never closes.
        expect(unstableChromeRenderCount).toBeLessThanOrEqual(2);
    });
});
