declare const require: (id: string) => unknown;

// Preserve the production module order. The shared boundary replaces only
// native root registration; it leaves Router, layouts and providers real.
require('../../../../index');

async function seedCredentials() {
    const { upsertAndActivateServer } = require('@/sync/domains/server/serverRuntime') as typeof import('@/sync/domains/server/serverRuntime');
    const { TokenStorage } = require('@/auth/storage/tokenStorage') as typeof import('@/auth/storage/tokenStorage');
    const home = await upsertAndActivateServer({ serverUrl: location.origin, name: 'Cold startup browser' });
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature',
    });
}


function mount() {
    const { mountStartupRoot } = require('./workflowRouteStartupRootBoundary') as typeof import('./workflowRouteStartupRootBoundary');
    mountStartupRoot();
}

Object.assign(globalThis, { coldRootHarness: { seedCredentials, mount } });

export {};
