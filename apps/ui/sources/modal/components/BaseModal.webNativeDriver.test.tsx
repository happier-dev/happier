import * as React from 'react';
import { act } from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];
const requireRadixDialogMock = vi.fn(() => ({
    Root: ({ children, ...rest }: any) => React.createElement('Root', rest, children),
    Portal: ({ children, ...rest }: any) => React.createElement('Portal', rest, children),
    Overlay: ({ children, ...rest }: any) => React.createElement('Overlay', rest, children),
    Content: ({ children, ...rest }: any) => React.createElement('Content', rest, children),
    Title: ({ children, ...rest }: any) => React.createElement('Title', rest, children),
}));
const requireRadixDismissableLayerMock = vi.fn(() => ({
    Branch: ({ children, ...rest }: any) => React.createElement('Branch', rest, children),
}));

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
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('@/utils/web/radixCjs', () => ({
  requireRadixDialog: requireRadixDialogMock,
  requireRadixDismissableLayer: requireRadixDismissableLayerMock,
}));

vi.mock('@/modal/portal/ModalPortalTarget', () => ({
  ModalPortalTargetProvider: ({ target, children }: any) => React.createElement('ModalPortalTargetProvider', { target }, children),
}));

describe('BaseModal (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
    requireRadixDialogMock.mockClear();
    requireRadixDismissableLayerMock.mockClear();
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

  it('does not use Radix Dialog primitives on web (avoids focus-scope ref churn)', async () => {
    const { BaseModal } = await import('./BaseModal');

    const rendered = await renderScreen(
      <BaseModal visible={true}>
        <div />
      </BaseModal>,
    );
    expect(requireRadixDismissableLayerMock).toHaveBeenCalledTimes(1);
    expect(requireRadixDialogMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      rendered.tree.update(
        <BaseModal visible={true}>
          <div />
          <div />
        </BaseModal>,
      );
    });
    expect(requireRadixDismissableLayerMock).toHaveBeenCalledTimes(1);
    expect(requireRadixDialogMock).toHaveBeenCalledTimes(0);
  });

  it('does not render Radix Dialog.Portal on web (avoids Slot ref-churn loops)', async () => {
    const { BaseModal } = await import('./BaseModal');

    const rendered = await renderScreen(
      <BaseModal visible={true}>
        <div />
      </BaseModal>,
    );

    const portals = rendered.findAllByType('Portal');
    expect(portals).toHaveLength(0);
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

  it('does not churn portal target state on ref detach (avoids update-depth loops)', async () => {
    const { BaseModal } = await import('./BaseModal');

    const rendered = await renderScreen(
      <BaseModal visible={true}>
        <div />
      </BaseModal>,
    );

    const portalHost = rendered.find((node: any) => node?.type === 'div' && node?.props?.['data-happy-modal-portal-host'] === '');
    // We use a ref object + layout effect to set the portal target, rather than setting state inside
    // a callback ref (which can create ref attach/detach loops on web).
    expect(typeof portalHost.props.ref).toBe('object');

    const provider = () => rendered.findByType('ModalPortalTargetProvider');
    const before = provider().props.target;
    // react-test-renderer does not attach real DOM nodes to host refs, so the portal target
    // remains null here; the important property is that we avoid callback-ref state updates.
    expect(before).toBe(null);

    await act(async () => {
      rendered.tree.update(
        <BaseModal visible={true}>
          <div />
          <div />
        </BaseModal>,
      );
    });
    expect(provider().props.target).toBe(before);
  });
});
