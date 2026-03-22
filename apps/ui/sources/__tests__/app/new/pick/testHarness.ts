import type React from 'react';
import { vi } from 'vitest';

import {
    createExpoRouterMock,
    createStackOptionsCapture as createRawStackOptionsCapture,
    type StackOptionsCapture,
    type StackScreenOptions,
    type StackScreenOptionsInput,
} from '@/dev/testkit/mocks/router';

type ReactActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type HeaderButtonElement = React.ReactElement<{ onPress?: () => void; disabled?: boolean }> | null | undefined;

export type PickerStackScreenOptions = StackScreenOptions & Readonly<{
  presentation?: string;
  headerLeft?: () => HeaderButtonElement;
  headerRight?: () => HeaderButtonElement;
}>;

export type PickerStackOptionsCapture = Omit<StackOptionsCapture, 'getResolved'> & Readonly<{
  getResolved: () => PickerStackScreenOptions | null;
}>;

export type { StackScreenOptionsInput as PickerStackOptionsInput };

export type PickerNavigationRoute = Readonly<{
    key: string;
    name?: string;
    path?: string;
    params?: Record<string, unknown>;
}>;

export type PickerNavigationState = Readonly<{
    index: number;
    routes: PickerNavigationRoute[];
}>;

export function createStackOptionsCapture(): PickerStackOptionsCapture {
    const capture = createRawStackOptionsCapture();
    return {
        ...capture,
        getResolved: () => capture.getResolved() as PickerStackScreenOptions | null,
    };
}

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

export function createRouterMock() {
    const { spies } = createExpoRouterMock();
    return {
        push: spies.push,
        back: spies.back,
        replace: spies.replace,
        setParams: spies.setParams,
    };
}

export function createNavigationMock(): {
    dispatch: ReturnType<typeof vi.fn>;
    getState: () => PickerNavigationState;
    goBack: ReturnType<typeof vi.fn>;
    setParams: ReturnType<typeof vi.fn>;
} {
    return {
        dispatch: vi.fn(),
        getState: () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }),
        goBack: vi.fn(),
        setParams: vi.fn(),
    };
}

export function cloneNavigationState(state: PickerNavigationState): PickerNavigationState {
    return {
        index: state.index,
        routes: state.routes.map((route) => ({
            key: route.key,
            ...(route.name ? { name: route.name } : {}),
            ...(route.path ? { path: route.path } : {}),
            ...(route.params ? { params: route.params } : {}),
        })),
    };
}
