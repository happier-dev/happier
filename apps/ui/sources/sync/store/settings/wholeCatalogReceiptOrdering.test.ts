import { describe, expect, it } from 'vitest';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 as providers } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyAcknowledgedMcpServerCatalog, applyMcpServerCatalogSnapshot, getMcpServerCatalogSnapshot } from './mcpServerCatalogSnapshot';
import { applyAcknowledgedAcpCatalog, applyAcpCatalogSnapshot, getAcpCatalogSnapshot } from './acpCatalogSnapshot';
import { applyAcknowledgedProviderCatalog, applyProviderCatalogSnapshot, getProviderCatalogSnapshot } from './providerCatalogSnapshot';
import { applyAcknowledgedConnectedAccountCatalog, applyConnectedAccountCatalogSnapshot, getConnectedAccountCatalogValue } from './connectedAccountCatalogSnapshot';
import { applyAcknowledgedConnectedMetadata, applyConnectedMetadataCatalogSnapshot, getConnectedMetadataCatalog } from './connectedMetadataCatalogSnapshot';
import { applyAcknowledgedNotificationChannelCatalog, applyNotificationChannelCatalogSnapshot, getNotificationChannelCatalogValue } from './notificationChannelCatalogSnapshot';
import { applyAcknowledgedRemoteHostCatalog, applyRemoteHostCatalogSnapshot, getRemoteHostCatalogSnapshot } from './remoteHostCatalogSnapshot';

const mcp = { v: 1 as const, servers: [], bindings: [] };
const acp = { v: 1 as const, definitions: [] };
const configuration = { key: 'configurations' as const, value: { v: 1 as const, entries: [] } };
const cases = [
    { domain: 'ACP unreadable', seed: (scope: ServerAccountScope) => applyAcpCatalogSnapshot(scope,
        { status: 'unavailable', reason: 'invalid-stored-content', revision: 10 }, true),
        fail: (scope: ServerAccountScope) => applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedAcpCatalog(scope, acp, revision, current),
        read: getAcpCatalogSnapshot },
    { domain: 'MCP', seed: (scope: ServerAccountScope) => applyMcpServerCatalogSnapshot(scope,
        { status: 'partial', authority: 'active', revision: 10, catalog: mcp, diagnostics: [] }, true),
        fail: (scope: ServerAccountScope) => applyMcpServerCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedMcpServerCatalog(scope, mcp, revision, current),
        read: getMcpServerCatalogSnapshot },
    { domain: 'ACP', seed: (scope: ServerAccountScope) => applyAcpCatalogSnapshot(scope,
        { status: 'partial', reason: 'incomplete-inventory', revision: 10, record: acp, diagnostics: [] }, true),
        fail: (scope: ServerAccountScope) => applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedAcpCatalog(scope, acp, revision, current),
        read: getAcpCatalogSnapshot },
    { domain: 'Provider', seed: (scope: ServerAccountScope) => applyProviderCatalogSnapshot(scope,
        { status: 'partial', revision: 10, catalog: providers, diagnostics: [] }, true),
        fail: (scope: ServerAccountScope) => applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedProviderCatalog(scope, providers, revision, current, null),
        read: getProviderCatalogSnapshot },
    { domain: 'Connected configurations', seed: (scope: ServerAccountScope) => applyConnectedAccountCatalogSnapshot(scope, 'configurations',
        { status: 'partial', authority: 'active', revision: 10, record: configuration, diagnostics: [] }, true),
        fail: (scope: ServerAccountScope) => applyConnectedAccountCatalogSnapshot(scope, 'configurations', { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedConnectedAccountCatalog(scope, configuration, revision, current),
        read: (scope: ServerAccountScope) => getConnectedAccountCatalogValue(scope, 'configurations') },
    { domain: 'Connected metadata', seed: (scope: ServerAccountScope) => applyConnectedMetadataCatalogSnapshot(scope,
        { presentation: { status: 'partial', revision: 10, entries: [], diagnostics: [] }, acknowledgements: { status: 'loading' } }, true),
        fail: (scope: ServerAccountScope) => applyConnectedMetadataCatalogSnapshot(scope,
            { presentation: { status: 'unavailable', reason: 'unreachable' }, acknowledgements: { status: 'loading' } }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedConnectedMetadata(scope,
            { kind: 'presentation', record: { v: 1, entries: [] } }, revision, current),
        read: getConnectedMetadataCatalog },
    { domain: 'Notifications', seed: (scope: ServerAccountScope) => applyNotificationChannelCatalogSnapshot(scope,
        { catalog: { status: 'partial', revision: 10, channels: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 0 }, true),
        fail: (scope: ServerAccountScope) => applyNotificationChannelCatalogSnapshot(scope,
            { catalog: { status: 'unavailable', reason: 'unreachable' }, rawSettings: {}, sourceSettingsVersion: 0 }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedNotificationChannelCatalog(scope, [], revision, current),
        read: getNotificationChannelCatalogValue },
    { domain: 'Remote hosts', seed: (scope: ServerAccountScope) => applyRemoteHostCatalogSnapshot(scope,
        { status: 'partial', revision: 10, hosts: [], diagnostics: [] }, true),
        fail: (scope: ServerAccountScope) => applyRemoteHostCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true),
        ack: (scope: ServerAccountScope, revision: number, current: boolean) => applyAcknowledgedRemoteHostCatalog(scope, [], revision, current),
        read: getRemoteHostCatalogSnapshot },
];

describe('whole-catalog receipt ordering at snapshot owners', () => {
    it.each([
        { domain: 'MCP', ack: (scope: ServerAccountScope) => applyAcknowledgedMcpServerCatalog(scope,
            { ...mcp, servers: [{ id: 'received-server', name: 'received-server', transport: 'stdio',
                stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] }, 11, true),
        publish: (scope: ServerAccountScope, revision: number | 'absent') => applyMcpServerCatalogSnapshot(scope,
            { status: 'ready', authority: revision === 'absent' ? 'inactive' : 'active', revision, diagnostics: [], catalog: mcp }, true),
        read: getMcpServerCatalogSnapshot },
        { domain: 'ACP', ack: (scope: ServerAccountScope) => applyAcknowledgedAcpCatalog(scope,
            { ...acp, definitions: [AcpBackendDefinitionV1Schema.parse({ id: 'received-agent', name: 'received-agent', title: 'Received agent',
                launch: { kind: 'command', command: 'agent', args: [] }, createdAt: 1, updatedAt: 1 })] }, 11, true),
        publish: (scope: ServerAccountScope, revision: number | 'absent') => applyAcpCatalogSnapshot(scope,
            revision === 'absent' ? { status: 'ready', revision, record: acp, source: 'fresh', sourceSettingsVersion: 0 }
                : { status: 'ready', revision, record: acp }, true),
        read: getAcpCatalogSnapshot },
    ])('$domain does not let an older or absent read replace acknowledged membership', ({ domain, ack, publish, read }) => {
        const scope = { serverId: `whole-read-order-${domain}`, accountId: 'owner' };
        ack(scope);
        const received = read(scope);
        publish(scope, 10);
        expect(read(scope)).toBe(received);
        publish(scope, 'absent');
        expect(read(scope)).toBe(received);
    });

    it.each(cases)('$domain retains partial revision through failed revalidation, admitting only current nonolder receipts', ({ domain, seed, fail, ack, read }) => {
        const scope = { serverId: `whole-order-${domain}`, accountId: 'owner' };
        seed(scope);
        fail(scope);
        const retained = read(scope);
        ack(scope, 6, true);
        expect(read(scope)).toBe(retained);
        ack(scope, 11, false);
        expect(read(scope)).toBe(retained);
        ack({ ...scope, accountId: 'foreign' }, 6, true);
        expect(read(scope)).toBe(retained);
        ack(scope, 11, true);
        expect(read(scope)).not.toBe(retained);
        const newer = read(scope);
        if (domain === 'ACP unreadable') {
            seed(scope);
            expect(read(scope)).toBe(newer);
        }
        ack(scope, 10, true);
        expect(read(scope)).toBe(newer);
    });
});
