import { describe, expect, it, vi } from 'vitest';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { resolveMachineAgentState } from '@/agents/machineAgents/resolveMachineAgentState';
import {
    getSelectableBackendEntriesForNewSession,
    getSelectableAgentIdsForNewSession,
    isBackendEntrySelectableForNewSession,
    isAgentSelectableForNewSession,
    resolveNextSelectableBackendEntryForNewSession,
    resolveNextSelectableAgentForNewSession,
    resolveBackendEntryUnavailabilityReasonForNewSession,
    resolveProfileAvailabilityForNewSession,
    resolveAgentLaunchBlockedReasonForNewSession,
    type NewSessionSelectableBackendEntry,
} from './newSessionAgentSelection';
import { beginAcpCatalogLoad, getAcpCatalogSnapshot, applyAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

function createMachineAgent(agentId: MachineAgent['agentId'], overrides: Partial<MachineAgent> = {}): MachineAgent {
    const agent: MachineAgent = {
        agentId, title: agentId, state: 'ready', stale: false, installed: true,
        version: null, latestVersion: null, update: null,
        signIn: { status: 'signedIn', via: null, nativeLogin: 'unsupported', connectedServices: [] },
        platform: { supported: true },
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
        dependencies: [], job: null, ...overrides,
    };
    return { ...agent, state: overrides.state ?? resolveMachineAgentState(agent) };
}

const claudeEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'claude' }, backendTargetKey: 'agent:happier.agent.claude/claude',
    builtInAgentId: 'claude', agentId: 'claude', kind: 'builtInAgent',
};
const codexEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'codex' }, backendTargetKey: 'agent:happier.agent.codex/codex',
    builtInAgentId: 'codex', agentId: 'codex', kind: 'builtInAgent',
};
const configuredEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
    backendTargetKey: 'backend:review-bot:configured:review-bot',
    builtInAgentId: null, agentId: 'review-bot', kind: 'configuredBackend',
};

describe('newSessionAgentSelection', () => {
    // Coordination 2026-11-04: unknown inventory does not establish unavailability.
    it('allows launch when a failed cold Machine check has no Agent row', () => {
        expect(resolveAgentLaunchBlockedReasonForNewSession({ backendTarget: codexEntry.backendTarget,
            selectedBackendEntry: codexEntry, projectionPhase: 'error', acpCatalog: null, agentLabel: 'Codex',
            selectedCredentialMachineAgent: null, machineAgentsStatus: 'error',
            agentStartBlock: null,
        })).toBeNull();
    });

    it('keeps a known installed Agent selectable while required sign-in is unknown', () => {
        const agent = createMachineAgent('codex', { state: 'unknown',
            signIn: { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [] } });
        expect(isAgentSelectableForNewSession({ agentId: 'codex', machineAgentsById: { codex: agent } })).toBe(true);
        expect(resolveAgentLaunchBlockedReasonForNewSession({ backendTarget: codexEntry.backendTarget,
            selectedBackendEntry: codexEntry, projectionPhase: 'ready', acpCatalog: null, agentLabel: 'Codex',
            selectedCredentialMachineAgent: agent, machineAgentsStatus: 'ready', agentStartBlock: null })).toBeNull();
    });
    it.each(['external', 'configured', 'legacyConfigured'] as const)('keeps an unresolved %s target checking only while its catalog is loading', (kind) => {
        const scope = { serverId: `new-session-${kind}`, accountId: 'readiness-test' };
        beginAcpCatalogLoad(scope);
        const backendTarget = kind === 'external'
            ? { kind: 'agent' as const, identity: { pluginId: 'acme.review', localId: 'review' } }
            : kind === 'configured'
                ? { kind: 'agent' as const, identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review' }
                : { kind: 'backend' as const, backendId: 'review', configuredBackendId: 'review' };
        const params = {
            backendTarget, selectedBackendEntry: null,
            projectionPhase: kind === 'external' ? 'loading' as const : 'ready' as const,
            acpCatalog: getAcpCatalogSnapshot(scope)!.catalog,
            agentLabel: 'Review', selectedCredentialMachineAgent: null,
            machineAgentsStatus: 'ready' as const, agentStartBlock: null,
        };
        expect(resolveAgentLaunchBlockedReasonForNewSession(params)).toBe('machineAgents.checking');
        applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            ...params, projectionPhase: 'error', acpCatalog: getAcpCatalogSnapshot(scope)!.catalog,
        })).toBe('newSession.selectAiBackendTitle');
        // Loading the other catalog cannot turn a settled missing target into
        // a check in progress: each target has one availability authority.
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            ...params,
            projectionPhase: kind === 'external' ? 'ready' : 'loading',
            acpCatalog: kind === 'external' ? { status: 'loading' } : getAcpCatalogSnapshot(scope)!.catalog,
        })).toBe('newSession.selectAiBackendTitle');
    });

    it('does not withdraw a ready bundled target while unrelated catalogs load', () => {
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            backendTarget: codexEntry.backendTarget, selectedBackendEntry: codexEntry,
            projectionPhase: 'loading', acpCatalog: { status: 'loading' },
            agentLabel: 'Codex', selectedCredentialMachineAgent: createMachineAgent('codex'),
            machineAgentsStatus: 'ready', agentStartBlock: null,
        })).toBeNull();
    });
    it('allows selection before the selected machine has been checked', () => {
        expect(isAgentSelectableForNewSession({ agentId: 'codex', machineAgentsById: {} })).toBe(true);
    });

    it.each([
        { stale: true }, { state: 'checking' }, { state: 'unknown', installed: false },
    ] satisfies ReadonlyArray<Partial<MachineAgent>>)('allows uncertain inventory through picker, profile and launch (%j)', overrides => {
        const agent = createMachineAgent('codex', overrides);
        const machineAgentsById = { codex: agent };
        expect(isBackendEntrySelectableForNewSession({ entry: codexEntry, machineAgentsById })).toBe(true);
        expect(resolveProfileAvailabilityForNewSession({ candidateBackendEntries: [codexEntry], machineAgentsById }))
            .toEqual({ available: true });
        expect(resolveAgentLaunchBlockedReasonForNewSession({ backendTarget: codexEntry.backendTarget,
            selectedBackendEntry: codexEntry, projectionPhase: 'ready', acpCatalog: null, agentLabel: 'Codex',
            selectedCredentialMachineAgent: agent, machineAgentsStatus: 'loading', agentStartBlock: null })).toBeNull();
    });

    it.each([
        { installed: false },
        { signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] } },
        { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] },
        { platform: { supported: false, reason: 'arch' } },
    ] satisfies ReadonlyArray<Partial<MachineAgent>>)('blocks launch for positively known unavailability (%j)', overrides => {
        expect(resolveAgentLaunchBlockedReasonForNewSession({ backendTarget: codexEntry.backendTarget,
            selectedBackendEntry: codexEntry, projectionPhase: 'ready', acpCatalog: null, agentLabel: 'Codex',
            selectedCredentialMachineAgent: createMachineAgent('codex', overrides), machineAgentsStatus: 'ready',
            agentStartBlock: null })).not.toBeNull();
    });

    it('does not select Antigravity when its dependency exists but its own CLI is missing', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'antigravity',
            machineAgentsById: { antigravity: createMachineAgent('antigravity', {
                installed: false,
                dependencies: [{ key: 'dep.antigravity-acp', title: 'ACP server', installed: true, version: '1.0.0' }],
            }) },
        })).toBe(false);
    });

    it.each([
        ['missing dependency', { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] }],
        ['installing', { state: 'installing' }],
        ['failed', { state: 'failed' }],
        ['unsupported', { platform: { supported: false, reason: 'arch' } }],
    ] satisfies ReadonlyArray<readonly [string, Partial<MachineAgent>]>)('does not select an agent that is %s', (_label, overrides) => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex', machineAgentsById: { codex: createMachineAgent('codex', overrides) },
        })).toBe(false);
    });

    it('trusts canonical readiness when the installed Agent has an unknown sign-in status', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            machineAgentsById: { codex: createMachineAgent('codex', {
                state: 'ready',
                signIn: { status: 'unknown', via: null, nativeLogin: 'unsupported', connectedServices: [] },
            }) },
        })).toBe(true);
    });

    it('accepts ready and update-available rows through the same list and cycling policy', () => {
        const machineAgentsById = {
            claude: createMachineAgent('claude'), codex: createMachineAgent('codex', { installed: false }),
            opencode: createMachineAgent('opencode', {
                version: '1.0.0', latestVersion: '2.0.0', update: { supported: true, command: 'update' },
            }),
        };
        expect(getSelectableAgentIdsForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], machineAgentsById,
        })).toEqual(['claude', 'opencode']);
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'claude', machineAgentsById,
        })).toBe('opencode');
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'opencode', machineAgentsById,
        })).toBe('claude');
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'codex', machineAgentsById,
        })).toBe('opencode');
    });

    it('cycles unresolved Agents without waiting for inventory', () => {
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex'], currentAgentId: 'claude', machineAgentsById: {},
        })).toBe('codex');
    });

    it('keeps profiles available unless every compatible Agent is known unavailable', () => {
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry],
            machineAgentsById: { claude: createMachineAgent('claude', { installed: false }), codex: createMachineAgent('codex') },
        })).toEqual({ available: true });
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById: {},
        })).toEqual({ available: true });
    });

    it('does not describe unknown or stale inventory as a missing CLI', () => {
        for (const agent of [
            undefined,
            createMachineAgent('codex', { state: 'unknown', stale: true }),
            createMachineAgent('codex', { stale: true }),
        ]) {
            const machineAgentsById = { codex: agent };
            expect(resolveBackendEntryUnavailabilityReasonForNewSession({ entry: codexEntry, machineAgentsById }))
                .toBeNull();
            expect(isBackendEntrySelectableForNewSession({ entry: codexEntry, machineAgentsById })).toBe(true);
        }
        expect(resolveBackendEntryUnavailabilityReasonForNewSession({
            entry: codexEntry, machineAgentsById: { codex: createMachineAgent('codex', { installed: false }) },
        })).toBe('cli-not-detected:codex');
    });

    it('allows choosing installed signed-out Agents and compatible Profiles before admitting launch credentials', () => {
        const machineAgentsById = {
            claude: createMachineAgent('claude', { state: 'needsSignIn' }),
            codex: createMachineAgent('codex', { state: 'needsSignIn' }),
        };
        expect(isAgentSelectableForNewSession({ agentId: 'claude', machineAgentsById })).toBe(true);
        expect(getSelectableBackendEntriesForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById,
        })).toEqual([claudeEntry, codexEntry]);
        expect(resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], currentTargetKey: claudeEntry.backendTargetKey, machineAgentsById,
        })).toEqual(codexEntry);
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [codexEntry], machineAgentsById,
        })).toEqual({ available: true });
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById,
        })).toEqual({ available: true });
    });

    it.each([
        { installed: false },
        { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] },
        { platform: { supported: false, reason: 'arch' } },
    ] satisfies ReadonlyArray<Partial<MachineAgent>>)('never treats sign-out as a bypass for executable eligibility (%j)', (overrides) => {
        expect(isBackendEntrySelectableForNewSession({ entry: claudeEntry,
            machineAgentsById: { claude: createMachineAgent('claude', { ...overrides, state: 'needsSignIn' }) },
        })).toBe(false);
    });

    it('keeps configured ACP targets selectable without Agent inventory', () => {
        expect(isBackendEntrySelectableForNewSession({ entry: configuredEntry, machineAgentsById: {} })).toBe(true);
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [configuredEntry], machineAgentsById: {},
        })).toEqual({ available: true });
        expect(resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: [claudeEntry, configuredEntry], currentTargetKey: claudeEntry.backendTargetKey,
            machineAgentsById: {},
        })).toEqual(configuredEntry);
    });

    it('allows plugin backends before their contributed Agent inventory is known', () => {
        const entry: NewSessionSelectableBackendEntry = {
            backendTarget: { kind: 'backend', backendId: 'acme.review' }, backendTargetKey: 'backend:acme.review',
            builtInAgentId: null, agentId: 'acme.review/assistant', kind: 'pluginBackend',
        };
        expect(isBackendEntrySelectableForNewSession({ entry, machineAgentsById: {} })).toBe(true);
        expect(isBackendEntrySelectableForNewSession({
            entry, machineAgentsById: { 'acme.review/assistant': createMachineAgent('acme.review/assistant') },
        })).toBe(true);
    });

    it('excludes targets that explicitly do not support session runtime', () => {
        const entry = { ...configuredEntry, capabilities: { session: { supported: false }, executionRun: { supported: true } } };
        expect(getSelectableBackendEntriesForNewSession({ candidateBackendEntries: [entry], machineAgentsById: {} })).toEqual([]);
        expect(resolveProfileAvailabilityForNewSession({ candidateBackendEntries: [entry], machineAgentsById: {} }))
            .toEqual({ available: false, reason: 'no-supported-cli' });
    });
});
