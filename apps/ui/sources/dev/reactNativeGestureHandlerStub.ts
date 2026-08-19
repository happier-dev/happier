// Vitest/node stub for `react-native-gesture-handler`.
// The real package pulls in React Native internals (`react-native/Libraries/...`) which Vitest can't parse.
//
// The chain implementation is owned by the testkit mock so a suite gets the same
// recorded `__config`/`__handlers` shape whether it mocks the module explicitly
// (`createGestureHandlerMock`) or falls through to this global alias.
// Component exports stay host-element strings here: suites relying on this alias
// query the rendered tree by `'GestureDetector'` / `'GestureHandlerScrollView'`.

import { createGestureFactories } from './testkit/mocks/gestureHandler';

export type {
    TestGestureCallback,
    TestGestureChain,
    TestGestureHitSlop,
    TestGestureKind,
} from './testkit/mocks/gestureHandler';

export const Gesture = createGestureFactories();

export const GestureDetector = 'GestureDetector';

// Many UI components use gesture-handler's ScrollView for better nested gesture interop.
export const ScrollView = 'GestureHandlerScrollView';

export const GestureHandlerRootView = 'GestureHandlerRootView';

export const Swipeable = 'Swipeable';
