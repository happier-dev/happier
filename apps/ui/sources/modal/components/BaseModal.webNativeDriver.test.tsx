import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
            Animated: {
                Value: function Value(this: any, initial: number) {
                this.__value = initial;
              },
                timing: (_value: any, config: any) => {
                capturedTimingConfigs.push(config);
                return { start: () => undefined };
              },
            },
            View: (props: any) => React.createElement('View', props, props.children),
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/utils/web/radixCjs', () => ({
  requireRadixDialog: () => ({ Root: ({ children }: any) => React.createElement('Root', null, children) }),
  requireRadixDismissableLayer: () => ({ Branch: ({ children }: any) => React.createElement('Branch', null, children) }),
}));

vi.mock('@/modal/portal/ModalPortalTarget', () => ({
  ModalPortalTargetProvider: ({ children }: any) => React.createElement('ModalPortalTargetProvider', null, children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('BaseModal (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
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
});
