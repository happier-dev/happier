import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const inspectInput = defineProtocolObject({ sessionId: defineProtocolString() }, { policy: 'closed' });

/** External author: declarations stay cold; only ordinary Actions/Resources activate. */
export function createListExtensionSource(onResourceRead: () => void = () => {}) {
    return definePlugin({
        id: 'com.acme.release', version: '1.0.0',
        resources: { release: { source: 'dynamic', kind: 'asset', contentType: 'application/json', scope: 'session',
            runtime: { read: () => { onResourceRead(); return 'ready'; }, observe: () => ({ dispose() {} }) } } },
        actions: { inspect: {
            title: 'Inspect release', surfaces: ['ui'], dangerLevel: 'safe', scopes: ['session'],
            placementBindings: ['contextMenu', 'rowAction'], sessionTarget: { field: 'sessionId', cardinality: 'one' },
            inputSchema: inspectInput,
            run: input => ({ inspected: true, sessionId: input.sessionId }),
        } },
        ui: { listExtensions: { releases: {
            entity: 'sessionWork',
            filterFields: [{ id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' }, value: { kind: 'set' } }],
            rowMark: { fieldId: 'release-stage', slot: 'context' },
        } } },
    });
}

/** Service columns use the same cold declaration path as held filter fields. */
export function createServiceColumnSource(onResourceRead: () => void = () => {}) {
    return definePlugin({
        id: 'com.acme.requests', version: '1.0.0',
        resources: { requests: { source: 'dynamic', kind: 'asset', contentType: 'application/json', scope: 'surface',
            runtime: { read: () => { onResourceRead(); return 0; }, observe: () => ({ dispose() {} }) } } },
        ui: { listExtensions: { traffic: {
            entity: 'service',
            filterFields: [{ id: 'requests', title: 'Requests · 24 h', source: { resource: 'requests' },
                value: { kind: 'number', unit: '{request}' },
                column: { title: 'Requests', width: 112, align: 'end', priority: 20, defaultHidden: true },
            }],
        } } },
    });
}

/** Session-targeting Account code has no daemon or Machine dependency. */
export function createAccountSessionRowActionSource(onRun: (sessionId: string) => void, form = false) {
    return definePlugin({
        id: 'com.acme.account-review', version: '1.0.0',
        actions: { inspect: {
            title: 'Inspect Account review', scopes: ['session'], surfaces: ['ui'], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
            placementBindings: ['contextMenu', 'rowAction'], sessionTarget: { field: 'sessionId', cardinality: 'one' },
            inputSchema: inspectInput,
            ...(form ? { inputHints: { fields: [{ path: 'sessionId', title: 'Session', widget: 'text' as const }] } } : {}),
            run: input => { onRun(input.sessionId); return { inspected: true }; },
        } },
    });
}
