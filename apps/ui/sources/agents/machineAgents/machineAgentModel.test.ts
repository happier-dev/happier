import { describe, expect, it } from 'vitest';
import { projectMachineAgent, projectMachineAgentForCredential, reconcileMachineAgents, resolveMachineAgentSignIn } from './machineAgentModel';
import type { MachineAgent } from './machineAgentTypes';

describe('machine agent projection', () => {
    it('uses only an admitted Provider route to suppress its replaced native authentication', () => {
        const serviceId = 'happier.agent.claude/claude-subscription';
        const agent = projectMachineAgent({ agentId: 'claude', title: 'Claude', checking: false, stale: false, job: null,
            connectedServices: [{ serviceId, title: 'Claude subscription', connected: false, healthy: false, profileLabel: null, profiles: [] }],
            facts: { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1', update: null,
                signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, platform: { supported: true },
                install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] } });
        const providerRoute = { ready: true, suppressedConnectedServiceIds: ['claude-subscription', 'anthropic'] };
        const selection = { credentialBindings: null, providerRoute };
        expect(projectMachineAgentForCredential(agent, selection)).toMatchObject({ state: 'ready', signIn: { status: 'signedOut' } });
        expect(projectMachineAgentForCredential({ ...agent, signIn: { ...agent.signIn,
            native: { status: 'unknown', loginSupport: 'login_terminal' }, status: 'unknown' } }, selection)?.state).toBe('ready');
        expect(projectMachineAgentForCredential(agent, { ...selection, credentialBindings: { v: 2, bindingsByServiceId: {
            [serviceId]: { source: 'connected', selection: 'profile', profileId: 'expired' },
        } } })?.state).toBe('ready');
        expect(projectMachineAgentForCredential(agent, { ...selection, credentialBindings: { v: 2, bindingsByServiceId: {
            'acme.agent/anthropic': { source: 'connected', selection: 'profile', profileId: 'missing' },
        } } })?.state).toBe('unknown');
        expect(projectMachineAgentForCredential(agent, { credentialBindings: null })?.state).toBe('needsSignIn');
        expect(projectMachineAgentForCredential(agent, { ...selection, providerRoute: { ...providerRoute, ready: false } })?.state).toBe('unknown');
        expect(projectMachineAgentForCredential(agent, { ...selection, providerRoute: { ...providerRoute, suppressedConnectedServiceIds: [] } })?.state).toBe('needsSignIn');
        expect(projectMachineAgentForCredential({ ...agent, stale: true }, selection)?.stale).toBe(true);
        expect(projectMachineAgentForCredential({ ...agent, installed: false, state: 'notInstalled' }, selection)?.state).toBe('notInstalled');
        expect(projectMachineAgentForCredential({ ...agent, platform: { supported: false, reason: 'arch' } }, selection)?.state).toBe('unsupported');
        expect(projectMachineAgentForCredential({ ...agent, signIn: { ...agent.signIn, connectedServices: [
            ...agent.signIn.connectedServices, { serviceId: 'acme.agent/anthropic', title: 'Other account', connected: false,
                healthy: false, profileLabel: null, profiles: [] },
        ] } }, selection)?.state).toBe('needsSignIn');
    });
    it('admits a selected healthy account or pool without native CLI sign-in proof', () => {
        const serviceId = 'happier.agent.claude/claude-account';
        const agent: MachineAgent = {
            agentId: 'claude', title: 'Claude', installed: true, state: 'ready', stale: false,
            version: null, latestVersion: null, update: null, job: null, dependencies: [],
            platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
            signIn: resolveMachineAgentSignIn({
                native: { status: 'unknown', loginSupport: 'status_only' },
                connectedServices: [{ serviceId, title: 'Claude subscription', connected: true, healthy: true,
                    profileLabel: 'Work', profiles: [{ profileId: 'work', healthy: true, profileLabel: 'Work' }] }],
            }),
        };
        const project = (binding: { source: 'connected'; selection: 'profile'; profileId: string }
            | { source: 'connected'; selection: 'group'; groupId: string }) => projectMachineAgentForCredential(agent, {
            credentialBindings: { v: 2, bindingsByServiceId: { [serviceId]: binding } },
            groupOptionsByServiceId: { [serviceId]: [{ groupId: 'pool', label: 'Pool', activeProfileId: 'work',
                memberProfileIds: ['work'], generation: 1, enabledMemberCount: 1, autoSwitch: false, status: 'ready' }] },
        });
        for (const selected of [
            project({ source: 'connected', selection: 'profile', profileId: 'work' }),
            project({ source: 'connected', selection: 'group', groupId: 'pool' }),
        ]) {
            expect(selected).toMatchObject({ state: 'ready', signIn: { status: 'signedIn', via: { kind: 'connected', serviceId } } });
        }
        expect(project({ source: 'connected', selection: 'profile', profileId: 'missing' })?.state).toBe('needsSignIn');
        expect(projectMachineAgentForCredential(agent, { credentialBindings: null })?.state).toBe('unknown');
        expect(projectMachineAgentForCredential({ ...agent, installed: false, state: 'notInstalled' }, {
            credentialBindings: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' } } },
        })?.state).toBe('notInstalled');
    });
    it('a healthy accepted connected account satisfies sign-in when the native CLI is signed out', () => {
        const connectedServices = [{ serviceId: 'chatgpt', title: 'ChatGPT', connected: true, healthy: true, profileLabel: 'Work' }];
        expect(resolveMachineAgentSignIn({ native: { status: 'signedOut', loginSupport: 'login_terminal' }, connectedServices })).toMatchObject({
            status: 'signedIn', via: { kind: 'connected', serviceId: 'chatgpt', title: 'ChatGPT', profileLabel: 'Work' },
        });
        expect(resolveMachineAgentSignIn({ native: { status: 'signedOut', loginSupport: 'login_terminal' }, connectedServices: [{ ...connectedServices[0], healthy: false }] }).status).toBe('signedOut');
    });
    it('preserves individual agent references and suppresses a no-op list update', () => {
        const initial = ['claude', 'codex'].map((agentId) => projectMachineAgent({ agentId, title: agentId, facts: null, checking: true, stale: false, connectedServices: [], job: null }));
        const same = initial.map((agent) => ({ ...agent }));
        expect(reconcileMachineAgents(initial, same)).toBe(initial);
        const changed = reconcileMachineAgents(initial, [same[0], { ...same[1], stale: true }]);
        expect(changed[0]).toBe(initial[0]);
        expect(changed[1]).not.toBe(initial[1]);
    });
    it('does not infer native authentication when a selected connected service has not been projected', () => {
        expect(resolveMachineAgentSignIn({ native: { status: 'signedIn', loginSupport: 'status_only' },
            connectedServices: [], credentialBindings: { v: 2, bindingsByServiceId: {
                'acme.agent/account': { source: 'connected', selection: 'profile', profileId: 'work' },
            } },
        })).toMatchObject({ status: 'unknown', via: null });
    });
    it('uses only the launch credential while retaining aggregate connected availability', () => {
        const connectedServices = [{ serviceId: 'acme.agent/account', title: 'Account', connected: true, healthy: true, profileLabel: 'Work',
            profiles: [{ profileId: 'work', healthy: true, profileLabel: 'Work' }, { profileId: 'expired', healthy: false, profileLabel: 'Expired' }] }];
        const native = { status: 'signedOut' as const, loginSupport: 'login_terminal' as const };
        expect(resolveMachineAgentSignIn({ native, connectedServices }).status).toBe('signedIn');
        expect(resolveMachineAgentSignIn({ native, connectedServices, credentialBindings: null }).status).toBe('signedOut');
        expect(resolveMachineAgentSignIn({ native: { ...native, status: 'signedIn' }, connectedServices, credentialBindings: null }).via).toMatchObject({ kind: 'native' });
        const binding = (profileId: string) => ({ v: 2 as const, bindingsByServiceId: {
            'acme.agent/account': { source: 'connected' as const, selection: 'profile' as const, profileId },
        } });
        expect(resolveMachineAgentSignIn({ native, connectedServices, credentialBindings: binding('work') }).status).toBe('signedIn');
        expect(resolveMachineAgentSignIn({ native: { ...native, status: 'signedIn' }, connectedServices, credentialBindings: binding('expired') }).status).toBe('signedOut');
        expect(resolveMachineAgentSignIn({ native, connectedServices: [], credentialBindings: null }).status).toBe('signedOut');
        const groupBinding = { v: 2 as const, bindingsByServiceId: { 'acme.agent/account': {
            source: 'connected' as const, selection: 'group' as const, groupId: 'team',
        } } };
        const group = { groupId: 'team', label: 'Team', activeProfileId: 'expired', memberProfileIds: ['work', 'expired'],
            generation: 1, enabledMemberCount: 2, autoSwitch: false, status: 'ready' as const };
        expect(resolveMachineAgentSignIn({ native, connectedServices, credentialBindings: groupBinding,
            groupOptionsByServiceId: { 'acme.agent/account': [group] } }).status).toBe('signedOut');
        expect(resolveMachineAgentSignIn({ native, connectedServices, credentialBindings: groupBinding,
            groupOptionsByServiceId: { 'acme.agent/account': [{ ...group, activeProfileId: 'work' }] } }).status).toBe('signedIn');
    });
});
