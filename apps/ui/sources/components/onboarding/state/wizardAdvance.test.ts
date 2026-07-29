import { describe, expect, it } from 'vitest';

import { resolveWizardAdvance } from './wizardAdvance';
import { wizardStepRegistry } from './wizardStepRegistry';
import type {
    WizardAuthIntent,
    WizardContext,
    WizardPlatform,
    WizardRelaySelection,
    WizardState,
    WizardStepId,
} from './wizardTypes';

const cloudRelay = {
    serverId: 'cloud-profile',
    serverUrl: 'https://api.happier.dev',
};

const baseRelaySelection: WizardRelaySelection = {
    choiceId: null,
    serverUrl: null,
    relayProfileId: null,
    locked: false,
};

function buildState(params: Readonly<{
    mode: WizardContext['mode'];
    stepId: WizardStepId;
    platform?: WizardPlatform;
    authIntent?: WizardAuthIntent;
    relaySelection?: Partial<WizardRelaySelection>;
    setupAction?: WizardContext['setupAction'];
    canRunSystemTasks?: boolean;
}>): WizardState {
    const platform = params.platform ?? 'desktop';
    return {
        context: {
            mode: params.mode,
            platform,
            canScanQr: false,
            scanStepEnabled: false,
            canRunSystemTasks: params.canRunSystemTasks ?? platform === 'desktop',
            relaySelection: {
                ...baseRelaySelection,
                ...params.relaySelection,
            },
            relayAccessProviderId: null,
            relayLockConfirmationPending: false,
            relaySwitchConfirmationPending: false,
            authIntent: params.authIntent ?? 'standard',
            setupAction: params.setupAction ?? null,
        },
        currentStepId: params.stepId,
        history: [],
        resumeState: null,
        parsedScanPayload: null,
    };
}

describe('resolveWizardAdvance', () => {
    it.each([
        { platform: 'desktop' as const, nextStepId: 'auth' as const },
        { platform: 'web' as const, nextStepId: 'auth' as const },
        { platform: 'native' as const, nextStepId: 'auth' as const },
    ])('resolves cloud relay selection on $platform with activation effects', ({ platform, nextStepId }) => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_select',
                platform,
                relaySelection: { choiceId: 'cloud' },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                activeServerMatchesSelectedRelay: false,
                cloudRelay,
            },
        );

        expect(result).toEqual({
            nextStepId,
            effects: [
                { type: 'activateServerProfile', serverId: 'cloud-profile', scope: 'device' },
                {
                    type: 'setRelaySelection',
                    relaySelection: {
                        choiceId: 'cloud',
                        serverUrl: 'https://api.happier.dev',
                        relayProfileId: null,
                        locked: false,
                    },
                },
            ],
        });
    });

    it.each([
        { platform: 'desktop' as const, choiceId: 'thisComputer' as const, expected: 'host_relay_local' as const },
        { platform: 'web' as const, choiceId: 'thisComputer' as const, expected: 'desktop_handoff' as const },
        { platform: 'native' as const, choiceId: 'thisComputer' as const, expected: 'desktop_handoff' as const },
        { platform: 'desktop' as const, choiceId: 'remoteComputer' as const, expected: 'host_relay_remote' as const },
    ])('resolves pre-auth relay branch $choiceId on $platform', ({ platform, choiceId, expected }) => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_select',
                platform,
                relaySelection: { choiceId },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                isDesktopShell: platform === 'desktop',
                cloudRelay,
            },
        );

        expect(result).toEqual({
            nextStepId: expected,
            effects: [],
        });
    });

    it('routes manual custom relay selection with no URL to relay URL entry', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_select',
                relaySelection: { choiceId: 'customUrl', serverUrl: null, relayProfileId: null },
            }),
            wizardStepRegistry,
            { type: 'primary', cloudRelay },
        );

        expect(result).toEqual({
            nextStepId: 'relay_enter_url',
            effects: [],
        });
    });

    it.each([
        { platform: 'desktop' as const },
        { platform: 'web' as const },
        { platform: 'native' as const },
    ])('resolves saved/custom relay selection with URL on $platform', ({ platform }) => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_select',
                platform,
                relaySelection: {
                    choiceId: 'customUrl',
                    serverUrl: 'https://saved-relay.example.test',
                    relayProfileId: 'saved-profile',
                },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                activeServerMatchesSelectedRelay: false,
                cloudRelay,
            },
        );

        expect(result).toEqual({
            nextStepId: 'auth',
            effects: [
                {
                    type: 'activateServerUrl',
                    serverUrl: 'https://saved-relay.example.test',
                    source: 'url',
                    scope: 'device',
                },
                {
                    type: 'setRelaySelection',
                    relaySelection: {
                        choiceId: 'customUrl',
                        serverUrl: 'https://saved-relay.example.test',
                        relayProfileId: 'saved-profile',
                        locked: false,
                    },
                },
                { type: 'persistOnboardingIntent', relayUrl: 'https://saved-relay.example.test' },
            ],
        });
    });

    it.each([
        { platform: 'web' as const },
        { platform: 'native' as const },
    ])('resolves Phase-0 fixed this-computer URL handoff route on $platform', ({ platform }) => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_enter_url',
                platform,
                relaySelection: { choiceId: 'thisComputer' },
            }),
            wizardStepRegistry,
            {
                type: 'saveCustomRelayUrl',
                relayUrl: 'https://local-relay.example.test',
                relayProfileId: null,
            },
        );

        expect(result).toEqual({
            nextStepId: 'background_service_handoff',
            effects: [
                {
                    type: 'activateServerUrl',
                    serverUrl: 'https://local-relay.example.test',
                    source: 'url',
                    scope: 'device',
                },
                { type: 'clearRelayAccessDraft' },
                {
                    type: 'setRelaySelection',
                    relaySelection: {
                        choiceId: 'thisComputer',
                        serverUrl: 'https://local-relay.example.test',
                        relayProfileId: null,
                        locked: false,
                    },
                },
                { type: 'persistOnboardingIntent', relayUrl: 'https://local-relay.example.test' },
            ],
        });
    });

    it('routes saved custom relay URL entry to restore auth when restore intent is active', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'onboarding',
                stepId: 'relay_enter_url',
                authIntent: 'restore',
                relaySelection: { choiceId: 'customUrl' },
            }),
            wizardStepRegistry,
            {
                type: 'saveCustomRelayUrl',
                relayUrl: 'https://restore-relay.example.test',
                relayProfileId: 'profile:https://restore-relay.example.test',
            },
        );

        expect(result.nextStepId).toBe('auth_restore');
        expect(result.effects).toContainEqual({ type: 'persistOnboardingIntent', relayUrl: 'https://restore-relay.example.test' });
    });

    it('uses the registry fallback for ordinary onboarding advances', () => {
        const result = resolveWizardAdvance(
            buildState({ mode: 'onboarding', stepId: 'background_service_handoff', platform: 'web', relaySelection: { choiceId: 'thisComputer', serverUrl: 'https://relay.example.test' } }),
            wizardStepRegistry,
            { type: 'primary', cloudRelay },
        );

        expect(result).toEqual({
            nextStepId: 'auth',
            effects: [],
        });
    });

    it.each([
        { setupAction: 'local' as const, expected: 'setup_this_computer' as const },
        { setupAction: 'relayLocal' as const, expected: 'host_relay_local' as const },
        { setupAction: 'remote' as const, expected: 'remote_ssh_setup' as const },
    ])('resolves setup chooser branch $setupAction', ({ setupAction, expected }) => {
        const result = resolveWizardAdvance(
            buildState({ mode: 'setup', stepId: 'setup_chooser', setupAction }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup: true },
        );

        expect(result).toEqual({
            nextStepId: expected,
            effects: [],
        });
    });

    it.each([
        { allowProviderSetup: true, expected: 'providers_optional' as const },
        { allowProviderSetup: false, expected: 'done' as const },
    ])('resolves setup-this-computer after-provider target allowProviderSetup=$allowProviderSetup', ({ allowProviderSetup, expected }) => {
        const result = resolveWizardAdvance(
            buildState({ mode: 'setup', stepId: 'setup_this_computer', setupAction: 'local' }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup },
        );

        expect(result).toEqual({
            nextStepId: expected,
            effects: [],
        });
    });

    it('resolves relay-local hosting with a candidate URL to relay access and candidate effect', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'setup',
                stepId: 'host_relay_local',
                setupAction: 'relayLocal',
                relaySelection: { serverUrl: 'https://local-relay.example.test' },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                allowProviderSetup: true,
                activeServerUrl: 'https://active-relay.example.test',
            },
        );

        expect(result).toEqual({
            nextStepId: 'relay_access',
            effects: [
                {
                    type: 'setRelayRuntimeCandidate',
                    relayUrl: 'https://local-relay.example.test',
                    machineId: null,
                    relayAccessTarget: { kind: 'local' },
                },
            ],
        });
    });

    it.each([
        { stepId: 'relay_access' as const },
        { stepId: 'relay_access_prereqs' as const },
        { stepId: 'remote_ssh_setup' as const },
    ])('routes $stepId to confirm switch when a relay candidate exists', ({ stepId }) => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'setup',
                stepId,
                setupAction: 'remote',
                relaySelection: { serverUrl: 'https://candidate-relay.example.test' },
            }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup: true },
        );

        expect(result).toEqual({
            nextStepId: stepId === 'remote_ssh_setup' ? 'relay_access' : 'confirm_switch_relay',
            effects: [],
        });
    });

    it.each([
        { stepId: 'relay_access' as const },
        { stepId: 'relay_access_prereqs' as const },
        { stepId: 'remote_ssh_setup' as const },
    ])('routes $stepId to providers when no relay candidate exists', ({ stepId }) => {
        const result = resolveWizardAdvance(
            buildState({ mode: 'setup', stepId, setupAction: 'remote' }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup: true },
        );

        expect(result).toEqual({
            nextStepId: 'providers_optional',
            effects: [],
        });
    });

    it('keeps the active relay on setup relay-switch confirmation without effects', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'setup',
                stepId: 'confirm_switch_relay',
                setupAction: 'relayLocal',
                relaySelection: { serverUrl: 'https://local-relay.example.test' },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                allowProviderSetup: true,
                relaySwitchDecision: 'keep',
                effectiveRelayCandidateUrl: 'https://local-relay.example.test',
            },
        );

        expect(result).toEqual({
            nextStepId: 'providers_optional',
            effects: [],
        });
    });

    it('switches a local setup relay through pending auth effects', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'setup',
                stepId: 'confirm_switch_relay',
                setupAction: 'relayLocal',
                relaySelection: { serverUrl: 'https://local-relay.example.test' },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                allowProviderSetup: true,
                relaySwitchDecision: 'switch',
                effectiveRelayCandidateUrl: 'https://local-relay.example.test',
            },
        );

        expect(result).toEqual({
            nextStepId: null,
            effects: [
                {
                    type: 'activateServerUrl',
                    serverUrl: 'https://local-relay.example.test',
                    source: 'url',
                    scope: 'device',
                },
                {
                    type: 'setPendingSetupIntent',
                    intent: {
                        branch: 'thisComputer',
                        phase: 'awaiting_auth',
                        relayUrl: 'https://local-relay.example.test',
                    },
                },
                { type: 'exitSetup' },
                { type: 'navigate', route: '/' },
            ],
        });
    });

    it('switches a remote setup relay through pending auth effects with remote metadata', () => {
        const result = resolveWizardAdvance(
            buildState({
                mode: 'setup',
                stepId: 'confirm_switch_relay',
                setupAction: 'remote',
                relaySelection: { serverUrl: 'https://remote-relay.example.test' },
            }),
            wizardStepRegistry,
            {
                type: 'primary',
                allowProviderSetup: true,
                relaySwitchDecision: 'switch',
                effectiveRelayCandidateUrl: 'https://remote-relay.example.test',
                pendingRelayMachineId: 'remote-machine',
                remoteSetupIntent: 'remoteRelayHost',
            },
        );

        expect(result.effects).toContainEqual({
            type: 'setPendingSetupIntent',
            intent: {
                branch: 'remoteMachine',
                phase: 'awaiting_auth',
                relayUrl: 'https://remote-relay.example.test',
                machineId: 'remote-machine',
                remoteSetupIntent: 'remoteRelayHost',
            },
        });
        expect(result.nextStepId).toBeNull();
    });

    it('routes providers to done and done to exit effect', () => {
        expect(resolveWizardAdvance(
            buildState({ mode: 'setup', stepId: 'providers_optional', setupAction: 'local' }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup: true },
        )).toEqual({ nextStepId: 'done', effects: [] });

        expect(resolveWizardAdvance(
            buildState({ mode: 'setup', stepId: 'done', setupAction: 'local' }),
            wizardStepRegistry,
            { type: 'primary', allowProviderSetup: true },
        )).toEqual({ nextStepId: null, effects: [{ type: 'exitSetup' }] });
    });
});
