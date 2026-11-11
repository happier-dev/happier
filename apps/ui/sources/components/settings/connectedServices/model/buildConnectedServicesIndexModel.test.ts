import { describe, expect, it } from 'vitest';

import type {
    QualifiedConnectedAccountGroupV4,
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { getConnectedServiceRegistryIdentityFallback } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { presentConnectedServiceIndexDiagnostics } from './presentConnectedServiceIndexDiagnostics';

import { buildConnectedServicesIndexModel, type ConnectedServicesIndexAgentUse } from './buildConnectedServicesIndexModel';
import { buildConnectedServiceSetupCatalog } from '../setup/buildConnectedServiceSetupCatalog';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';

const CLAUDE = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
const CODEX = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const GEMINI = { pluginId: 'happier.agent.gemini', localId: 'gemini' };
const GITHUB = { pluginId: 'happier.scm-github', localId: 'github' };

function entry(service: { pluginId: string; localId: string }, title: string): ConnectedServiceRegistryEntry {
    return {
        serviceId: service.localId,
        service,
        connectCommand: `happier connect ${service.localId}`,
        supportsOauth: true,
        executable: true,
        projectedTitle: title,
    };
}

function account(service: { pluginId: string; localId: string }, accountId: string): QualifiedConnectedAccountProfileV4 {
    return {
        ref: { service, accountId },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: `cred-${accountId}`,
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
    } as unknown as QualifiedConnectedAccountProfileV4;
}

function pool(service: { pluginId: string; localId: string }, groupId: string, members: string[], active: string | null): QualifiedConnectedAccountGroupV4 {
    return {
        v: 1,
        ref: { service, groupId },
        displayName: 'Work pool',
        activeConnectedAccountId: active,
        policy: { strategy: 'least_limited', autoSwitch: true },
        members: members.map((connectedAccountId, index) => ({ connectedAccountId, priority: index, enabled: true })),
    } as unknown as QualifiedConnectedAccountGroupV4;
}

function build(agentUses: readonly ConnectedServicesIndexAgentUse[] | null) {
    return buildConnectedServicesIndexModel({
        transport: 'advertised-v4',
        entries: [entry(CLAUDE, 'Claude'), entry(CODEX, 'ChatGPT'), entry(GEMINI, 'Gemini'), entry(GITHUB, 'GitHub')],
        qualifiedAccounts: [account(CLAUDE, 'work'), account(CLAUDE, 'personal'), account(CODEX, 'me'), account(GITHUB, 'gh')],
        qualifiedGroups: [pool(CLAUDE, 'work-pool', ['work', 'personal'], 'work')],
        legacyServices: [],
        defaultAccountByServiceKey: {},
        resolveLabel: (candidate) => String(candidate?.projectedTitle ?? 'Unknown'),
        resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: null, supportDetails: null }),
        loadingLabel: 'Loading',
        agentUses,
    });
}

const AGENTS: readonly ConnectedServicesIndexAgentUse[] = [
    { agentId: 'claude', title: 'Claude Code', services: [CLAUDE], defaults: [{ kind: 'group', service: CLAUDE, groupId: 'work-pool' }] },
    { agentId: 'codex', title: 'Codex', services: [CODEX], defaults: [{ kind: 'account', account: { service: CODEX, accountId: 'me' } }] },
    { agentId: 'opencode', title: 'OpenCode', services: [CLAUDE, CODEX], defaults: [] },
    { agentId: 'gemini', title: 'Gemini CLI', services: [GEMINI], defaults: [] },
];

describe('buildConnectedServicesIndexModel · who uses what', () => {
    it('preserves released legacy credential kinds for the same compatibility owner', () => {
        const model = buildConnectedServicesIndexModel({
            transport: 'legacy', entries: [{ ...entry(CODEX, 'Source'), legacyServiceId: 'openai-codex' }],
            qualifiedAccounts: [], qualifiedGroups: [],
            legacyServices: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'subscription', kind: 'oauth', status: 'connected' }] }],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'Source', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
            agentUses: [{ title: 'Key only', services: [{ ...CODEX, credentialKinds: ['token'] }], defaults: [] },
                { title: 'Subscription', services: [{ ...CODEX, credentialKinds: ['oauth'] }], defaults: [] }],
        });
        expect(model.sheets[0].usedBy).toEqual(['Subscription']);
    });

    it('names only consumers compatible with each saved account kind, including mixed services', () => {
        const service = { pluginId: 'external.source', localId: 'models' };
        const declarations: readonly ConnectedServicesIndexAgentUse[] = [
            { agentId: 'subscription', title: 'Subscription', services: [{ ...service, credentialKinds: ['oauth'] }], defaults: [] },
            { agentId: 'key', title: 'Key', services: [{ ...service, credentialKinds: ['token'] }], defaults: [] },
            { agentId: 'both', title: 'Both', services: [service], defaults: [] },
        ];
        const project = (kinds: readonly ('oauth' | 'token')[]) => buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry(service, 'Source')],
            qualifiedAccounts: kinds.map(kind => ({ ...account(service, kind), kind })), qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'Source', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: declarations,
        }).sheets[0];
        expect(project(['oauth']).usedBy).toEqual(['Subscription', 'Both']);
        const mixed = project(['oauth', 'token']);
        expect(mixed.usedBy).toEqual(['Subscription', 'Key', 'Both']);
        expect(mixed.usedByByAccountId?.oauth).toEqual({ usedBy: ['Subscription', 'Both'], usedByAgentIds: ['subscription', 'both'] });
        expect(mixed.usedByByAccountId?.token).toEqual({ usedBy: ['Key', 'Both'], usedByAgentIds: ['key', 'both'] });
        expect(project(['token']).usedBy).toEqual(['Key', 'Both']);
    });

    it.each([1, 2])('keeps declared multi-account services addable with %s saved accounts and no Machine execution', (count) => {
        const services = [CODEX, { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }];
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries: [], registryStatus: 'ready',
            qualifiedAccounts: services.flatMap(service => Array.from({ length: count }, (_, index) => account(service, `saved-${index}`))),
            qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: (_entry, service) => service.localId, resolveFallbackEntry: getConnectedServiceRegistryIdentityFallback,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [] });
        expect(model.sheets).toHaveLength(2);
        expect(model.sheets.map(sheet => ({ canAdd: sheet.canAdd, count: sheet.connectedCount, executable: sheet.entry?.executable })))
            .toEqual([{ canAdd: true, count, executable: false }, { canAdd: true, count, executable: false }]);
        expect(buildConnectedServiceSetupCatalog(model).every(service => service.canAdd && service.connectedCount === count)).toBe(true);
    });

    it('keeps a saved service pending while its descriptor registry has not answered, not waiting for an offline Machine', () => {
        const service = { pluginId: 'external.mail', localId: 'mail' };
        const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries: [], registryStatus: 'loading',
            qualifiedAccounts: [account(service, 'saved')], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: () => 'Mail', resolveFallbackEntry: getConnectedServiceRegistryIdentityFallback,
            presentDiagnostics: entry => presentConnectedServiceIndexDiagnostics({ entry }), loadingLabel: 'Loading' });
        expect(model.sheets[0]).toMatchObject({ canAdd: false, statusLine: 'Loading', accounts: [{ accountId: 'saved' }] });
    });

    it('distinguishes a missing descriptor from a complete installation census and an explicit disable', () => {
        const service = { pluginId: 'acme.ledger', localId: 'ledger' };
        const project = (census: Readonly<{ pluginIds: ReadonlySet<string>; complete: boolean }> | null,
            descriptor: ConnectedServiceRegistryEntry | null = null) => buildConnectedServicesIndexModel({
                transport: 'advertised-v4', entries: descriptor ? [descriptor] : [],
                qualifiedAccounts: [account(service, 'saved')], qualifiedGroups: [], legacyServices: [],
                defaultAccountByServiceKey: {}, resolveLabel: () => 'Ledger', resolveFallbackEntry: () => null,
                presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
                pluginInstallationCensus: census,
            }).sheets[0];
        expect(project(null)).toMatchObject({ installationState: 'unknown', accounts: [{ accountId: 'saved' }] });
        expect(project({ pluginIds: new Set(), complete: false })).toMatchObject({ installationState: 'unknown' });
        expect(project({ pluginIds: new Set(), complete: true })).toMatchObject({ installationState: 'not-installed' });
        expect(project({ pluginIds: new Set([service.pluginId]), complete: false })).toMatchObject({ installationState: 'installed' });
        expect(project(null, { ...entry(service, 'Ledger'), executable: false, projectionStatus: 'ready',
            availability: { state: 'disabled', reason: 'plugin_disabled' } })).toMatchObject({ installationState: 'disabled' });
        expect(project({ pluginIds: new Set(), complete: true }, { ...entry(service, 'Ledger'), executable: false,
            projectionStatus: 'loading', availability: { state: 'disabled', reason: 'plugin_disabled' } }))
            .toMatchObject({ installationState: 'unknown' });
    });
    it('carries an authored Cloud machines category to setup without granting sign-in availability', () => {
        const service = { pluginId: 'external.cloud', localId: 'cloud' };
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: service.localId, title: 'Cloud', ui: { category: 'cloud-machines' },
            authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
        });
        const projectedDescriptor = projectConnectedAccountDescriptorV1({ descriptor, serviceId: service.localId, pluginId: service.pluginId,
            provenance: 'external', sourceKind: 'installed', availability: { state: 'blocked', reason: 'configuration-required' }, diagnostics: [] });
        const model = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [{ ...entry(service, 'Cloud'), projectedDescriptor, executable: false }],
            qualifiedAccounts: [account(service, 'work')], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: candidate => String(candidate?.projectedTitle ?? 'Unknown'), resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading', agentUses: [],
        });
        expect(buildConnectedServiceSetupCatalog(model)).toMatchObject([{ service, category: 'cloud-machines', section: 'tools', canAdd: false }]);
        expect(Object.fromEntries(buildConnectedServiceSetupCatalog(build(AGENTS)).map(row => [row.serviceKey, row.category]))).toEqual({
            'happier.agent.claude/anthropic': 'agent-sign-in',
            'happier.agent.codex/openai-codex': 'agent-sign-in',
            'happier.agent.gemini/gemini': 'agent-sign-in',
            'happier.scm-github/github': 'code-tools',
        });
    });
    it('keeps service order independent of descriptor arrival, labels and account health', () => {
        const project = (arrived: boolean) => buildConnectedServicesIndexModel({
            transport: 'advertised-v4',
            entries: arrived
                ? [entry(CODEX, 'ChatGPT'), entry(CLAUDE, 'Claude')]
                : [entry(CLAUDE, 'Loading Claude'), entry(CODEX, 'Loading ChatGPT')],
            qualifiedAccounts: [account(CLAUDE, 'work'), {
                ...account(CODEX, 'me'), status: arrived ? 'needs_reauth' : 'connected',
            }],
            qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: candidate => String(candidate?.projectedTitle ?? 'Unknown'),
            resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }),
            loadingLabel: 'Loading',
        });
        const keys = (model: ReturnType<typeof project>) => model.sheets.map(sheet => sheet.serviceKey);
        expect(keys(project(false))).toEqual([CLAUDE, CODEX].map(service => `${service.pluginId}/${service.localId}`));
        expect(keys(project(true))).toEqual(keys(project(false)));
        expect(project(true).sheets.find(sheet => sheet.service.pluginId === CODEX.pluginId)?.attentionAccountId).toBe('me');
    });

    it('keeps account positions while refreshed health settles without losing the attention target', () => {
        const project = (settled: boolean) => buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry(CODEX, 'ChatGPT')],
            qualifiedAccounts: [account(CODEX, 'a'), { ...account(CODEX, 'b'), status: settled ? 'needs_reauth' : 'connected' }],
            qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
            resolveLabel: () => 'ChatGPT', resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading',
        }).sheets[0]!;
        expect(project(false).accounts.map(account => account.accountId)).toEqual(['a', 'b']);
        expect(project(true).accounts.map(account => account.accountId)).toEqual(['a', 'b']);
        expect(project(true).attentionAccountId).toBe('b');
        expect(project(true).connectedCount).toBe(1);
    });

    it('names the agents that sign in with each service and splits agent accounts from code and tools', () => {
        const model = build(AGENTS);
        const claude = model.sheets.find((sheet) => sheet.service.localId === 'anthropic')!;
        const github = model.sheets.find((sheet) => sheet.service.localId === 'github')!;

        expect(claude.usedBy).toEqual(['Claude Code', 'OpenCode']);
        // Their marks sit at a card's foot (lab csvc C2).
        expect(claude.usedByAgentIds).toEqual(['claude', 'opencode']);
        expect(claude.section).toBe('agents');
        expect(github.usedBy).toEqual([]);
        expect(github.section).toBe('tools');
    });

    it('offers the services an agent accepts but nobody connected, with the agents that would use them (G3)', () => {
        const model = build(AGENTS);

        expect(model.connectable.map((service) => [service.label, service.usedBy, service.section]))
            .toEqual([['Gemini', ['Gemini CLI'], 'agents']]);
    });

    it('gives each account its roles: pools it is in (and which one uses it now) and the agents it is the default for', () => {
        const model = build(AGENTS);
        const claude = model.sheets.find((sheet) => sheet.service.localId === 'anthropic')!;
        const codex = model.sheets.find((sheet) => sheet.service.localId === 'openai-codex')!;

        expect(claude.rolesByAccountId.work).toEqual({
            pools: [{ groupId: 'work-pool', inUse: true }],
            defaultFor: [],
        });
        expect(claude.rolesByAccountId.personal).toEqual({
            pools: [{ groupId: 'work-pool', inUse: false }],
            defaultFor: [],
        });
        expect(codex.rolesByAccountId.me).toEqual({ pools: [], defaultFor: ['Codex'] });
        expect(claude.pools.map((group) => [group.ref.groupId, group.defaultFor])).toEqual([['work-pool', ['Claude Code']]]);
    });

    it('keeps unknown Agent usage distinct from Agent accounts and tools without losing saved accounts', () => {
        const model = build(null);

        expect(model.sheets.map(sheet => [sheet.section, sheet.usedBy])).toEqual([
            ['unknown', []], ['unknown', []], ['unknown', []],
        ]);
        expect(model.sheets.flatMap(sheet => sheet.accounts).map(account => account.accountId).sort())
            .toEqual(['gh', 'me', 'personal', 'work']);
        expect(buildConnectedServiceSetupCatalog(model).every(entry => entry.category === 'unknown')).toBe(true);
        expect(build([]).sheets.every(sheet => sheet.section === 'tools')).toBe(true);
    });

    it('leaves out a service with nothing in it and nothing to do yet, instead of an empty sheet', () => {
        // The machines did not answer: nothing can be added right now, and these services have no accounts.
        const unreachable = [entry(CODEX, 'ChatGPT'), entry(GEMINI, 'Gemini'), entry(GITHUB, 'GitHub')]
            .map((candidate): ConnectedServiceRegistryEntry => ({ ...candidate, executable: false, projectionStatus: 'stale' }));
        const model = buildConnectedServicesIndexModel({
            transport: 'advertised-v4',
            entries: unreachable,
            qualifiedAccounts: [account(CODEX, 'me')],
            qualifiedGroups: [],
            legacyServices: [],
            defaultAccountByServiceKey: {},
            resolveLabel: (candidate) => String(candidate?.projectedTitle ?? 'Unknown'),
            resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: null, supportDetails: null }),
            loadingLabel: 'Loading',
            agentUses: AGENTS,
        });

        expect(model.sheets.map((sheet) => sheet.label)).toEqual(['ChatGPT']);
        expect(model.connectable).toEqual([]);
    });

    it('keeps known auth declarations addable with retained health and diagnostics without admitting native execution', () => {
        const staleEntries = [entry(CODEX, 'ChatGPT'), entry(GEMINI, 'Gemini')].map((candidate): ConnectedServiceRegistryEntry => ({
            ...candidate,
            executable: false,
            projectionStatus: 'stale',
            availability: { state: 'available', reason: 'resolved' },
            projectionConflicts: [],
        }));
        const diagnostic = 'The service catalog could not be refreshed';
        const model = buildConnectedServicesIndexModel({
            transport: 'advertised-v4',
            entries: staleEntries,
            qualifiedAccounts: [{ ...account(CODEX, 'work'), status: 'needs_reauth' }],
            qualifiedGroups: [],
            legacyServices: [],
            defaultAccountByServiceKey: {},
            resolveLabel: (candidate) => String(candidate?.projectedTitle ?? 'Unknown'),
            resolveFallbackEntry: () => null,
            presentDiagnostics: () => ({ primary: diagnostic, supportDetails: null }),
            loadingLabel: 'Loading',
        });

        const codex = model.sheets.find((sheet) => sheet.serviceKey === 'happier.agent.codex/openai-codex');
        expect(codex).toMatchObject({
            canOpen: true,
            canAdd: true,
            attentionAccountId: 'work',
            statusLine: diagnostic,
            accounts: [{ accountId: 'work', status: 'needs_reauth' }],
            entry: { executable: false, projectionStatus: 'stale' },
        });
        // A known service with no accounts still carries its diagnostic; it is not discarded.
        expect(model.sheets.find((sheet) => sheet.service.localId === 'gemini')).toMatchObject({
            canOpen: true,
            canAdd: false,
            accounts: [],
            statusLine: diagnostic,
        });
        expect(buildConnectedServiceSetupCatalog(model).map((candidate) => [candidate.serviceKey, candidate.canAdd]))
            .toEqual([
                ['happier.agent.codex/openai-codex', true],
                ['happier.agent.gemini/gemini', false],
            ]);
    });
});
