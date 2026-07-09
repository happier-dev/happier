export async function activate(api) {
    const activatedAtMs = Date.now();

    api.registerAction({
        id: 'examples.reload.report',
        handler: async () => ({
            ok: true,
            data: {
                activatedAtMs
            }
        })
    });

    api.onDispose(async () => {
        return undefined;
    });
}
