/**
 * Vitest setup for the SHIPPED-NATIVE Legend lane (`vitest.legend-fabric.config.ts`).
 *
 * Two facts the shipped app has are decided at MODULE EVALUATION time inside
 * `@legendapp/list/react-native`, which is why they cannot be set from a test body:
 *
 *   1. `var f = global.nativeFabricUIManager; var IsNewArchitecture = f !== void 0 && f != null;`
 *      (react-native.mjs:366-367). Read once, at import. Everything downstream - `PositionView`
 *      (PositionViewState vs PositionViewAnimated), `canRender`'s initial value, layout-effect
 *      container measurement, `applyLayout`'s `.measure()` fallback - is frozen off that boolean.
 *   2. `var PlatformAdjustBreaksScroll = Platform.OS === "android"` (react-native.mjs, module
 *      scope). Read once, at import, off the `react-native` module object.
 *
 * Setup files run before the test file's import graph is evaluated, so this is the only point in a
 * run where either can still be chosen. That is what makes them lane decisions rather than test
 * decisions, and it is why this file - not each test - owns them: a test file cannot forget to
 * install an environment it never had to install.
 *
 * This file is deliberately NOT loaded by the legacy `*.native.real.integration.test.tsx` lane.
 * That lane's existing assertions were written against old-architecture rows; flipping it would
 * silently re-interpret every one of them.
 */
import { vi } from 'vitest';

import {
    installShippedNativeArchitecture,
    installShippedNativeFrameScheduler,
    resolveShippedNativeHarnessPlatform,
} from './shippedNativeLegendRuntime';

installShippedNativeArchitecture();
installShippedNativeFrameScheduler();

// Resolved inside the factory rather than captured here: `vi.mock` is hoisted above this file's
// statements, and the factory is the part that runs late enough to read module state safely.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('../mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: resolveShippedNativeHarnessPlatform() });
});
