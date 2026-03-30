export function applyInitialAppStateConnectivityGate(params: Readonly<{
    isForeground: boolean;
    pauseController: Readonly<{ pause: () => void }>;
    setNetworkAllowed: (allowed: boolean) => void;
}>): void {
    const allowed = params.isForeground === true;
    params.setNetworkAllowed(allowed);
    if (!allowed) {
        params.pauseController.pause();
    }
}
