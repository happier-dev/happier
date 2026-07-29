export async function activate(api) {
    const activatedAtMs = Date.now();

    api.actions.register('reload-report', async () => ({ activatedAtMs }));
    return async () => {
        return undefined;
    };
}
