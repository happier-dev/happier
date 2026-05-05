import { createContext, useContext, type ReactNode } from 'react';
import type { DemoState, DeviceFocus } from './types';

type Ctx = {
    state: DemoState;
    focus: DeviceFocus;
};

const MockSessionContext = createContext<Ctx | null>(null);

export function MockSessionProvider({
    value,
    children,
}: {
    value: Ctx;
    children: ReactNode;
}) {
    return <MockSessionContext.Provider value={value}>{children}</MockSessionContext.Provider>;
}

export function useMockSession(): Ctx {
    const ctx = useContext(MockSessionContext);
    if (!ctx) throw new Error('useMockSession must be used inside MockSessionProvider');
    return ctx;
}
