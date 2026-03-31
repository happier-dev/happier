import * as React from 'react';

export type EdgeInsets = Readonly<{ top: number; right: number; bottom: number; left: number }>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

export const initialWindowMetrics: Readonly<{ insets: EdgeInsets; frame: Rect }> = {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

export const SafeAreaProvider = ({ children }: React.PropsWithChildren) => {
    return React.createElement(React.Fragment, null, children);
};

export const SafeAreaView = ({ children }: React.PropsWithChildren) => {
    return React.createElement(React.Fragment, null, children);
};

export function useSafeAreaInsets(): EdgeInsets {
    return initialWindowMetrics.insets;
}

export function useSafeAreaFrame(): Rect {
    return initialWindowMetrics.frame;
}
