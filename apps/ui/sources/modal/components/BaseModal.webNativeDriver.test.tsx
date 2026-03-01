import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Platform: { ...(actual.Platform ?? {}), OS: 'web' },
    Animated: {
      ...(actual.Animated ?? {}),
      Value: function Value(this: any, initial: number) {
        this.__value = initial;
      },
      timing: (_value: any, config: any) => {
        capturedTimingConfigs.push(config);
        return { start: () => undefined };
      },
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (input: any) => (typeof input === 'function' ? input({}, {}) : input),
    hairlineWidth: 1,
  },
}));

vi.mock('@/utils/web/radixCjs', () => ({
  requireRadixDialog: () => ({ Root: ({ children }: any) => React.createElement('Root', null, children) }),
  requireRadixDismissableLayer: () => ({ Branch: ({ children }: any) => React.createElement('Branch', null, children) }),
}));

vi.mock('@/modal/portal/ModalPortalTarget', () => ({
  ModalPortalTargetProvider: ({ children }: any) => React.createElement('ModalPortalTargetProvider', null, children),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

describe('BaseModal (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
  });

  it('does not use native driver on web (avoids Animated warnings)', async () => {
    const { BaseModal } = await import('./BaseModal');

    await act(async () => {
      renderer.create(
        <BaseModal visible={false}>
          <div />
        </BaseModal>,
      );
    });

    expect(capturedTimingConfigs.length).toBeGreaterThan(0);
    for (const cfg of capturedTimingConfigs) {
      expect(cfg.useNativeDriver).toBe(false);
    }
  });
});
