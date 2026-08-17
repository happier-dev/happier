import * as React from 'react';

type DemoStageUnmountGate = Readonly<{
    demoSeeded: boolean;
    setDemoSeeded: React.Dispatch<React.SetStateAction<boolean>>;
    unmountDemoStage: () => Promise<void>;
}>;

/**
 * Owns the handoff between the mounted demo stage and demo-world teardown.
 * Callers wait for `unmountDemoStage` so the real store is never restored while
 * a demo surface can still observe it.
 */
export function useDemoStageUnmountGate(): DemoStageUnmountGate {
    const [demoSeeded, setDemoSeeded] = React.useState(false);
    const unmountPromiseRef = React.useRef<Promise<void> | null>(null);
    const resolveUnmountRef = React.useRef<(() => void) | null>(null);

    const unmountDemoStage = React.useCallback((): Promise<void> => {
        if (!demoSeeded) return Promise.resolve();
        const existingUnmount = unmountPromiseRef.current;
        if (existingUnmount) return existingUnmount;

        let resolveUnmount!: () => void;
        const unmountPromise = new Promise<void>((resolve) => {
            resolveUnmount = resolve;
        });
        unmountPromiseRef.current = unmountPromise;
        resolveUnmountRef.current = () => {
            if (unmountPromiseRef.current === unmountPromise) {
                unmountPromiseRef.current = null;
                resolveUnmountRef.current = null;
            }
            resolveUnmount();
        };
        setDemoSeeded(false);
        return unmountPromise;
    }, [demoSeeded]);

    React.useLayoutEffect(() => {
        if (demoSeeded) return;
        resolveUnmountRef.current?.();
    }, [demoSeeded]);

    React.useEffect(() => () => {
        resolveUnmountRef.current?.();
    }, []);

    return { demoSeeded, setDemoSeeded, unmountDemoStage };
}
