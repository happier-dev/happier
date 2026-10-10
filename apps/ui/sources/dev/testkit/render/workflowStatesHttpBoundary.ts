import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';

// Only HTTP is modeled: Account authority, public Action admission, parsers,
// trigger projection, store and mounted read lifetimes remain production code.
const pending = new Set<(response: Response) => void>();
let failed = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});
export function failTriggerReads() {
    failed = true;
    for (const resolve of pending) resolve(json({ error: 'unavailable' }, 503));
    pending.clear();
}
export function installWorkflowStatesHttpBoundary() {
    setRuntimeFetch(async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return json({});
        if (path === '/v1/features') return json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return json({ content: null, version: 0 });
        if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture({ updatedAt: 0 }));
        if (path === '/v1/artifacts') return json([]);
        if (path === '/v3/automations' && (!init?.method || init.method === 'GET')) {
            return failed ? json({ error: 'unavailable' }, 503) : new Promise<Response>(resolve => pending.add(resolve));
        }
        return json({ error: 'not_found' }, 404);
    });
}
