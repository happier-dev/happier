import { describe, expect, it } from 'vitest';
import { compileEntityListFilterV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { connectedServicesColumnAdapter, connectedAccountColumnFacts } from '../connectedServices/collection/connectedServicesColumnAdapter';
import { buildConnectedServicesIndexModel } from '../connectedServices/model/buildConnectedServicesIndexModel';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { providerColumnAdapter } from '../providers/collection/providerColumnAdapter';
import { skillsColumnAdapter } from '../skills/skillsColumnAdapter';
import { mcpColumnAdapter, mcpColumnFacts } from '../mcpServers/collection/mcpColumnAdapter';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { agentColumnAdapter } from '../agents/collection/agentColumnAdapter';
import { machineColumnAdapter } from '../machines/collection/machineColumnAdapter';
import { homeColumnAdapter } from '../server/collection/homeColumnAdapter';
import { teamColumnAdapter, teamMemberColumnAdapter, teamGroupColumnAdapter, teamInvitationColumnAdapter,
    teamCredentialColumnAdapter, teamDirectoryColumnAdapter } from '../teams/collection/teamColumnAdapters';
import { homePeopleColumnAdapter, homeTeamsColumnAdapter, homeIdentityProviderColumnAdapter } from '../home/governance/homeAdministrationColumnAdapters';
import { profileColumnAdapter } from '../profiles/profileColumnAdapter';
import { roleColumnAdapter } from '../roles/roleColumnAdapter';
import { tokenColumnAdapter } from '../apiTokens/collection/tokenColumnAdapter';
import { embedColumnAdapter } from '../embeds/embedColumnAdapter';
import { remoteHostColumnAdapter } from '../remoteHosts/collection/remoteHostColumnAdapter';
import { promptColumnAdapter } from '../prompts/collection/promptColumnAdapter';
import { pluginColumnAdapter } from '../plugins/collection/pluginColumnAdapter';
import { secretColumnAdapter } from '../secrets/secretColumnAdapter';
import { defineSettingsCollectionAdapter } from './settingsCollectionAdapter';

function coverageCase(name: string, adapter: ReturnType<typeof defineSettingsCollectionAdapter<string>>) {
    return [name, () => {
        for (const field of adapter.fields) {
            const evaluate = compileEntityListFilterV1(adapter.registry, { [field]: { include: ['selected'], exclude: [] } });
            const row = { key: 'held', title: 'Not a source id', context: null, status: null, fields: {} };
            expect(evaluate(row)).toBe('unavailable');
            expect(evaluate({ ...row, fields: { [field]: [] } })).toBe('miss');
            expect(evaluate({ ...row, fields: { [field]: ['selected'] } })).toBe('match');
            expect(evaluate({ ...row, fields: { [field]: ['other'] } })).toBe('miss');
        }
    }] as const;
}

describe('P8 Settings inventory · held-fact condition contracts', () => {
    it.each([
        coverageCase('Connected services', connectedServicesColumnAdapter), coverageCase('Providers', providerColumnAdapter),
        coverageCase('Skills', skillsColumnAdapter), coverageCase('MCP', mcpColumnAdapter), coverageCase('Agents', agentColumnAdapter),
        coverageCase('Machines', machineColumnAdapter), coverageCase('Homes', homeColumnAdapter), coverageCase('Teams', teamColumnAdapter),
        coverageCase('Team members', teamMemberColumnAdapter), coverageCase('Team groups', teamGroupColumnAdapter),
        coverageCase('Team invitations', teamInvitationColumnAdapter), coverageCase('Team credentials', teamCredentialColumnAdapter),
        coverageCase('Team directory', teamDirectoryColumnAdapter), coverageCase('Home people', homePeopleColumnAdapter),
        coverageCase('Home Teams', homeTeamsColumnAdapter), coverageCase('Home identity providers', homeIdentityProviderColumnAdapter),
        coverageCase('Profiles', profileColumnAdapter), coverageCase('Roles', roleColumnAdapter), coverageCase('Tokens', tokenColumnAdapter),
        coverageCase('Embeds', embedColumnAdapter), coverageCase('Remote hosts', remoteHostColumnAdapter), coverageCase('Prompts/folders/stacks', promptColumnAdapter),
        coverageCase('Plugins Installed/Browse', pluginColumnAdapter), coverageCase('Secrets', secretColumnAdapter),
    ] as const)('%s preserves unavailable coverage rather than widening a selected condition', (_name, check) => check());

    it('retains qualified service identity and does not invent a sign-in failure for an unknown status', () => {
        const service = { pluginId: 'external.accounts', localId: 'same-name' };
        const sheet = buildConnectedServicesIndexModel({
            transport: 'legacy', entries: [{ serviceId: 'anthropic', service, legacyServiceId: 'anthropic',
                connectCommand: 'happier connect anthropic', supportsOauth: false, executable: false }],
            qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [{ serviceId: 'anthropic', profiles: [{
                profileId: 'opaque', status: 'future-peer-state', providerEmail: 'private@example.com',
            }] }], defaultAccountByServiceKey: {}, resolveLabel: () => 'External service', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
        }).sheets[0]!;
        expect(sheet).toBeDefined();
        const facts = connectedAccountColumnFacts({ sheet, account: sheet.accounts[0]!, labelsByKey: {},
            present: input => presentConnectedAccountIdentity({ hidden: true, label: input.label ?? null,
                labelKind: input.labelKind, email: input.email ?? null, accountId: input.accountId ?? null }) });
        expect(facts.fields.service).toEqual([sheet.serviceKey]);
        expect(facts.status).toBeNull();
        expect(facts.fields.status).toBeNull();
        expect(JSON.stringify(facts)).not.toContain('private@example.com');
        expect(compileEntityListFilterV1(connectedServicesColumnAdapter.registry,
            { status: { include: [], exclude: ['needs_reauth'] } })(facts)).toBe('unavailable');
    });
    it('keeps an Off MCP filter distinct from unknown Runs on and unknown tool count', () => {
        const server = McpServerCatalogEntryV1Schema.parse({ id: 'local', name: 'local', transport: 'stdio',
            stdio: { command: 'mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 });
        const row = { server, bindings: [], title: 'Local', unbound: true };
        const facts = mcpColumnFacts(row, { machineIds: null, statuses: [] });
        expect(compileEntityListFilterV1(mcpColumnAdapter.registry, { status: { include: ['off'], exclude: [] } })(facts)).toBe('match');
        expect(compileEntityListFilterV1(mcpColumnAdapter.registry, { runsOn: { include: [], exclude: ['other'] } })(facts)).toBe('unavailable');
        expect(facts.count).toBeNull();
        expect(mcpColumnFacts({ ...row, server: { ...server, toolsSnapshot: { checkedAt: 1, machineId: 'm', tools: [] } } },
            { machineIds: [], statuses: [] }).count).toBe(0);
    });
});
