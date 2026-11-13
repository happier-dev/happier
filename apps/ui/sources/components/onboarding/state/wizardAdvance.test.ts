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
                { type: 'activateServerProfile', serverId: 'cloud-profile' },
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

    it('routes the manual Home address choice to the Welcome connect step', () => {
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
            nextStepId: 'connect_home',
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
            },
        );

        expect(result).toEqual({
            nextStepId: 'background_service_handoff',
            effects: [
                {
                    type: 'activateServerUrl',
                    serverUrl: 'https://local-relay.example.test',
                    source: 'url',
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


});
