import type { PluginApiV1 } from '@happier-dev/plugin-sdk';

export async function activate(api: PluginApiV1): Promise<void> {
    api.registerAction({
        id: 'acme.sdk.final.action',
        handler: async (request) => ({ ok: true, data: { kind: 'action', input: request.input } }),
    });
    api.registerTool({
        id: 'acme.sdk.final.tool',
        handler: async (request) => ({ ok: true, data: { kind: 'tool', input: request.input } }),
    });
    api.registerHook({
        hookId: 'session.message.send',
        handler: async () => undefined,
    });
}
