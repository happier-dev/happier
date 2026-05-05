export async function activate(api) {
    const activatedAtMs = Date.now();

    api.registerAction({
        id: 'examples.reload.report',
        title: 'Report Reload Timestamp',
        description: 'Returns activation-time data so you can verify happier plugins reload.',
        surface: 'cli',
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
