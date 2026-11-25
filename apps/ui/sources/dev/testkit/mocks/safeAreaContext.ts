import { vi } from 'vitest';

type EdgeInsets = Readonly<{ top: number; right: number; bottom: number; left: number }>;

/**
 * The device safe-area SDK as one complete mock: every export of `react-native-safe-area-context` the app reads
 * (`SafeAreaInsetsContext` included, which `useOptionalSafeAreaInsets` reads directly), with the device's insets.
 * A test passes only the insets it needs; a partial inline mock fails to load once any surface in its graph reads an
 * export it left out.
 */
export async function createSafeAreaContextMock(insets?: EdgeInsets) {
    const stub = await vi.importActual<typeof import('../../reactNativeSafeAreaContextStub')>('@/dev/reactNativeSafeAreaContextStub');
    if (!insets) return stub;
    const React = await vi.importActual<typeof import('react')>('react');
    const SafeAreaInsetsContext = React.createContext<EdgeInsets>(insets);
    return {
        ...stub,
        initialWindowMetrics: { ...stub.initialWindowMetrics, insets },
        SafeAreaInsetsContext,
        useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext),
    };
}
