type ClosableApp = {
    close: () => Promise<unknown>;
};

export function createAppCloseTracker() {
    const trackedApps = new Set<ClosableApp>();

    function trackApp<T extends ClosableApp>(app: T): T {
        let closed = false;
        const originalClose = app.close.bind(app);

        app.close = (async () => {
            if (closed) {
                return;
            }
            closed = true;
            trackedApps.delete(app);
            await originalClose();
        }) as T["close"];

        trackedApps.add(app);
        return app;
    }

    async function closeTrackedApps(): Promise<void> {
        const pendingApps = Array.from(trackedApps);
        trackedApps.clear();
        for (const app of pendingApps) {
            try {
                await app.close();
            } catch {
                // Best-effort cleanup for partially initialized test apps.
            }
        }
    }

    return {
        trackApp,
        closeTrackedApps,
    };
}
