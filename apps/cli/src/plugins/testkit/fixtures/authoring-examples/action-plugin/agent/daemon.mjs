export async function executeAction(request = {}) {
    return {
        ok: true,
        data: {
            actionId: request.actionId ?? null,
            surface: request.context?.surface ?? 'cli',
            input: request.input ?? null
        }
    };
}
