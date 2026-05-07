import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    this.__value = initial;
                    this.interpolate = () => this;
                },
                timing: (_value: any, config: any) => {
                    capturedTimingConfigs.push(config);
                    return { start: () => undefined };
                },
                View: (props: any) => React.createElement('AnimatedView', props, props.children),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('@/utils/web/radixCjs', () => ({
  requireRadixDialog: () => ({
    Root: ({ children, ...rest }: any) => React.createElement('Root', rest, children),
    Portal: ({ children, ...rest }: any) => React.createElement('Portal', rest, children),
    Overlay: ({ children, ...rest }: any) => React.createElement('Overlay', rest, children),
    Content: ({ children, ...rest }: any) => React.createElement('Content', rest, children),
    Title: ({ children, ...rest }: any) => React.createElement('Title', rest, children),
  }),
  requireRadixDismissableLayer: () => ({
    Branch: ({ children, ...rest }: any) => React.createElement('Branch', rest, children),
  }),
}));

vi.mock('@/modal/portal/ModalPortalTarget', () => ({
  ModalPortalTargetProvider: ({ children }: any) => React.createElement('ModalPortalTargetProvider', null, children),
}));

describe('BaseModal (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
  });

  it('does not use Radix DismissableLayer.Branch asChild on web (avoids ref churn loops)', async () => {
    const { BaseModal } = await import('./BaseModal');

    const rendered = await renderScreen(
      <BaseModal visible={true}>
        <div />
      </BaseModal>,
    );

    const branch = rendered.findByType('Branch');
    expect(branch.props.asChild).toBeUndefined();
    expect(branch.props.style).toMatchObject({ display: 'contents' });
  });

  it('does not use native driver on web (avoids Animated warnings)', async () => {
    const { BaseModal } = await import('./BaseModal');

    await renderScreen(<BaseModal visible={false}>
          <div />
        </BaseModal>);

    expect(capturedTimingConfigs.length).toBeGreaterThan(0);
    for (const cfg of capturedTimingConfigs) {
      expect(cfg.useNativeDriver).toBe(false);
    }
  });

  it('uses the shared modal overlay enter and exit durations on web', async () => {
    const { BaseModal } = await import('./BaseModal');
    const { motionTokens } = await import('@/components/ui/motion/motionTokens');

    const rendered = await renderScreen(
      <BaseModal visible={true}>
        <div />
      </BaseModal>,
    );

    expect(capturedTimingConfigs.some((cfg) => cfg.duration === motionTokens.overlay.modal.enterMs)).toBe(true);

    await act(async () => {
      rendered.tree.update(
        <BaseModal visible={false}>
          <div />
        </BaseModal>,
      );
    });

    expect(capturedTimingConfigs.some((cfg) => cfg.duration === motionTokens.overlay.modal.exitMs)).toBe(true);
  });
});
