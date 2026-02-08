import type React from 'react';
import { vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type HeaderButtonElement = React.ReactElement<{ onPress?: () => void; disabled?: boolean }> | null | undefined;

export type PickerStackScreenOptions = Readonly<{
  presentation?: string;
  headerLeft?: () => HeaderButtonElement;
  headerRight?: () => HeaderButtonElement;
}> &
Readonly<Record<string, unknown>>;

export type PickerStackOptionsInput = PickerStackScreenOptions | (() => PickerStackScreenOptions);

export type StackOptionsCapture = {
  record: (options: PickerStackOptionsInput) => void;
  reset: () => void;
  getRaw: () => PickerStackOptionsInput | null;
  getResolved: () => PickerStackScreenOptions | null;
};

export function enableReactActEnvironment() {
  (globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
}

export const PICKER_NAV_STATE = { index: 1, routes: [{ key: 'a' }, { key: 'b' }] } as const;

export const PICKER_THEME_COLORS = {
  divider: '#ddd',
  groupped: { background: '#ffffff', sectionTitle: '#000' },
  header: { tint: '#000' },
  input: { background: '#fff', placeholder: '#aaa', text: '#000' },
  status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },
  surface: '#fff',
  textSecondary: '#666',
} as const;

export function resolvePickerStackOptions(options: PickerStackOptionsInput | null | undefined): PickerStackScreenOptions | null {
  if (!options) return null;
  return typeof options === 'function' ? options() : options;
}

export function createStackOptionsCapture(): StackOptionsCapture {
  let currentOptions: PickerStackOptionsInput | null = null;
  return {
    record(options) {
      currentOptions = options;
    },
    reset() {
      currentOptions = null;
    },
    getRaw() {
      return currentOptions;
    },
    getResolved() {
      return resolvePickerStackOptions(currentOptions);
    },
  };
}

export function createRouterMock() {
  return {
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  };
}

export function createNavigationMock() {
  return {
    dispatch: vi.fn(),
    getState: () => PICKER_NAV_STATE,
    goBack: vi.fn(),
    setParams: vi.fn(),
  };
}
