import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

/** Authored portable provider; only its external HTTP service is substituted by tests. */
export function activate(api: PluginAccountApi): void {
    for (const role of ['check', 'acquire', 'bootstrap', 'inspect', 'power', 'resize', 'destroy']) {
        api.actions.register(role, async (input, context) => {
            const response = await context.services.http.request({
                url: `https://native-provider.test/${role}`, method: 'POST', redirect: 'error',
                headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(input)),
            }, { signal: context.signal });
            if (response.status !== 200) throw new PluginError({ code: 'native_provider_unavailable' });
            return defineProtocolJsonValue().parse(JSON.parse(new TextDecoder().decode(response.body)));
        });
    }
}
