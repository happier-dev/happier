import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'ios',
  select: <T,>(options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>) => (
    options.ios ?? options.android ?? options.native ?? options.default
  ),
}));

vi.mock('react-native', () => ({
  Platform: nativePlatform,
  View: 'View',
}));

import { createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { HappierProgress } from '../presentation/content/Foundation.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  nativePlatform.OS = 'ios';
});

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('HappierProgress native responder contract', () => {
  for (const platform of ['ios', 'android'] as const) {
    it(`keeps non-interactive progress on the ${platform} responder path`, () => {
      nativePlatform.OS = platform;
      const context = createSurfaceContext({ platform });

      act(() => {
        renderer = create(
          <HappierProgress
            label="Installing"
            pointerEvents="none"
            testID="shared-progress"
            theme={context.theme}
          />,
        );
      });

      const progress = renderer!.root.findAll((node) => (
        node.type === 'View' && node.props.testID === 'shared-progress'
      ));
      expect(progress).toHaveLength(1);
      expect(progress[0]!.props.pointerEvents).toBe('none');
      expect(flattenStyle(progress[0]!.props.style).pointerEvents).toBeUndefined();
    });
  }
});
