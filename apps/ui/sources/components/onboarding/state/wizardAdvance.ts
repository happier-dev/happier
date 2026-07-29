import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type {
    WizardRelaySelection,
    WizardState,
    WizardStepDefinition,
    WizardStepId,
} from './wizardTypes';

export type WizardRemoteSetupIntent = 'remoteMachine' | 'remoteRelayHost';
export type WizardRelaySwitchDecision = 'keep' | 'switch';

export type WizardCloudRelay = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type WizardAdvanceRegistry = readonly Pick<WizardStepDefinition, 'id' | 'visibleWhen'>[];

export type WizardAdvanceEvent =
    | Readonly<{
        type: 'primary';
        isDesktopShell?: boolean;
        allowProviderSetup?: boolean;
        activeServerUrl?: string | null;
        activeServerMatchesSelectedRelay?: boolean;
        cloudRelay?: WizardCloudRelay | null;
        relayUrlForIntent?: string | null;
        relaySwitchDecision?: WizardRelaySwitchDecision;
        effectiveRelayCandidateUrl?: string | null;
        pendingRelayMachineId?: string | null;
        remoteSetupIntent?: WizardRemoteSetupIntent;
    }>
    | Readonly<{
        type: 'saveCustomRelayUrl';
        relayUrl: string;
        relayProfileId: string | null;
    }>;

export type WizardAdvanceEffect =
    | Readonly<{
        type: 'activateServerUrl';
        serverUrl: string;
        source: 'url';
        scope: 'device';
    }>
    | Readonly<{
        type: 'activateServerProfile';
        serverId: string;
        scope: 'device';
    }>
    | Readonly<{
        type: 'setRelaySelection';
        relaySelection: WizardRelaySelection;
    }>
    | Readonly<{
        type: 'persistOnboardingIntent';
        relayUrl: string | null;
    }>
    | Readonly<{ type: 'clearRelayAccessDraft' }>
    | Readonly<{
        type: 'setRelayRuntimeCandidate';
        relayUrl: string;
        machineId: string | null;
        relayAccessTarget: RelayAccessTaskTarget | null;
    }>
    | Readonly<{
        type: 'setPendingSetupIntent';
        intent:
            | Readonly<{
                branch: 'thisComputer';
                phase: 'awaiting_auth';
                relayUrl: string;
            }>
            | Readonly<{
                branch: 'remoteMachine';
                phase: 'awaiting_auth';
                relayUrl: string;
                machineId: string | null;
                remoteSetupIntent: WizardRemoteSetupIntent;
            }>;
    }>
    | Readonly<{ type: 'exitSetup' }>
    | Readonly<{ type: 'navigate'; route: '/' }>;

export type WizardAdvanceResolution = Readonly<{
    nextStepId: WizardStepId | null;
    effects: readonly WizardAdvanceEffect[];
}>;

function trimmed(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

function authStepFor(state: WizardState): WizardStepId {
    return state.context.authIntent === 'restore' ? 'auth_restore' : 'auth';
}

function afterProvidersStepId(event: WizardAdvanceEvent): WizardStepId {
    return event.type === 'primary' && event.allowProviderSetup === false ? 'done' : 'providers_optional';
}

function getNextVisibleStepId(
    state: WizardState,
    registry: WizardAdvanceRegistry,
): WizardStepId | null {
    const visibleStepIds = registry
        .filter((step) => step.visibleWhen(state.context))
        .map((step) => step.id);
    const currentIndex = visibleStepIds.indexOf(state.currentStepId);
    if (currentIndex < 0) {
        return null;
    }
    return visibleStepIds[currentIndex + 1] ?? null;
}

function resolveRelaySelectAdvance(
    state: WizardState,
    event: Extract<WizardAdvanceEvent, { type: 'primary' }>,
): WizardAdvanceResolution {
    const selection = state.context.relaySelection;
    const relayUrlForIntent =
        event.relayUrlForIntent === undefined
            ? undefined
            : (event.relayUrlForIntent === null ? null : trimmed(event.relayUrlForIntent));
    const intentEffect = relayUrlForIntent === undefined
        ? []
        : [{ type: 'persistOnboardingIntent' as const, relayUrl: relayUrlForIntent || null }];

    if (selection.choiceId === 'customUrl') {
        if (!selection.relayProfileId) {
            return { nextStepId: 'relay_enter_url', effects: intentEffect };
        }

        const serverUrl = trimmed(selection.serverUrl);
        if (!serverUrl) {
            return { nextStepId: 'relay_enter_url', effects: intentEffect };
        }

        const effects: WizardAdvanceEffect[] = [...intentEffect];
        if (event.activeServerMatchesSelectedRelay === false) {
            effects.push({
                type: 'activateServerUrl',
                serverUrl,
                source: 'url',
                scope: 'device',
            });
        }
        effects.push({
            type: 'setRelaySelection',
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl,
                relayProfileId: selection.relayProfileId,
                locked: selection.locked,
            },
        });
        if (relayUrlForIntent === undefined) {
            effects.push({ type: 'persistOnboardingIntent', relayUrl: serverUrl });
        }
        return { nextStepId: authStepFor(state), effects };
    }

    if (selection.choiceId === 'cloud') {
        const effects: WizardAdvanceEffect[] = [...intentEffect];
        if (event.cloudRelay && event.activeServerMatchesSelectedRelay === false) {
            effects.push({
                type: 'activateServerProfile',
                serverId: event.cloudRelay.serverId,
                scope: 'device',
            });
        }
        effects.push({
            type: 'setRelaySelection',
            relaySelection: {
                choiceId: 'cloud',
                serverUrl: event.cloudRelay?.serverUrl ?? null,
                relayProfileId: null,
                locked: false,
            },
        });
        return { nextStepId: 'auth', effects };
    }

    if (selection.choiceId === 'thisComputer') {
        return {
            nextStepId: event.isDesktopShell ? 'host_relay_local' : 'desktop_handoff',
            effects: intentEffect,
        };
    }

    if (selection.choiceId === 'remoteComputer') {
        return { nextStepId: 'host_relay_remote', effects: intentEffect };
    }

    return { nextStepId: 'auth', effects: intentEffect };
}

function resolveSaveCustomRelayUrl(
    state: WizardState,
    event: Extract<WizardAdvanceEvent, { type: 'saveCustomRelayUrl' }>,
): WizardAdvanceResolution {
    const relayUrl = trimmed(event.relayUrl);
    const isThisComputerHandoff =
        (state.context.platform === 'web' || state.context.platform === 'native')
        && state.context.relaySelection.choiceId === 'thisComputer';
    const choiceId = isThisComputerHandoff ? 'thisComputer' : 'customUrl';

    return {
        nextStepId: isThisComputerHandoff ? 'background_service_handoff' : authStepFor(state),
        effects: [
            {
                type: 'activateServerUrl',
                serverUrl: relayUrl,
                source: 'url',
                scope: 'device',
            },
            { type: 'clearRelayAccessDraft' },
            {
                type: 'setRelaySelection',
                relaySelection: {
                    choiceId,
                    serverUrl: relayUrl,
                    relayProfileId: choiceId === 'customUrl' ? event.relayProfileId : null,
                    locked: false,
                },
            },
            { type: 'persistOnboardingIntent', relayUrl },
        ],
    };
}

function resolveSetupAdvance(
    state: WizardState,
    event: Extract<WizardAdvanceEvent, { type: 'primary' }>,
    registry: WizardAdvanceRegistry,
): WizardAdvanceResolution {
    const setupAction = state.context.setupAction;
    const nextAfterProviders = afterProvidersStepId(event);
    const relayCandidateUrl = trimmed(state.context.relaySelection.serverUrl);

    if (state.currentStepId === 'setup_chooser') {
        if (setupAction === 'local') {
            return { nextStepId: 'setup_this_computer', effects: [] };
        }
        if (setupAction === 'relayLocal') {
            return { nextStepId: 'host_relay_local', effects: [] };
        }
        if (setupAction === 'remote') {
            return { nextStepId: 'remote_ssh_setup', effects: [] };
        }
        return { nextStepId: null, effects: [] };
    }

    if (state.currentStepId === 'setup_this_computer') {
        return { nextStepId: nextAfterProviders, effects: [] };
    }

    if (state.currentStepId === 'host_relay_local') {
        const nextRelayUrl = relayCandidateUrl || trimmed(event.activeServerUrl);
        if (nextRelayUrl) {
            return {
                nextStepId: 'relay_access',
                effects: [
                    {
                        type: 'setRelayRuntimeCandidate',
                        relayUrl: nextRelayUrl,
                        machineId: null,
                        relayAccessTarget: { kind: 'local' },
                    },
                ],
            };
        }
        return { nextStepId: nextAfterProviders, effects: [] };
    }

    if (state.currentStepId === 'relay_access' || state.currentStepId === 'relay_access_prereqs') {
        return {
            nextStepId: relayCandidateUrl ? 'confirm_switch_relay' : nextAfterProviders,
            effects: [],
        };
    }

    if (state.currentStepId === 'remote_ssh_setup') {
        return {
            nextStepId: relayCandidateUrl ? 'relay_access' : nextAfterProviders,
            effects: [],
        };
    }

    if (state.currentStepId === 'confirm_switch_relay') {
        const nextRelayUrl = trimmed(event.effectiveRelayCandidateUrl);
        if (!nextRelayUrl || event.relaySwitchDecision === 'keep') {
            return { nextStepId: nextAfterProviders, effects: [] };
        }

        const pendingIntent = setupAction === 'remote'
            ? {
                branch: 'remoteMachine' as const,
                phase: 'awaiting_auth' as const,
                relayUrl: nextRelayUrl,
                machineId: event.pendingRelayMachineId ?? null,
                remoteSetupIntent: event.remoteSetupIntent ?? 'remoteMachine',
            }
            : {
                branch: 'thisComputer' as const,
                phase: 'awaiting_auth' as const,
                relayUrl: nextRelayUrl,
            };

        return {
            nextStepId: null,
            effects: [
                {
                    type: 'activateServerUrl',
                    serverUrl: nextRelayUrl,
                    source: 'url',
                    scope: 'device',
                },
                { type: 'setPendingSetupIntent', intent: pendingIntent },
                { type: 'exitSetup' },
                { type: 'navigate', route: '/' },
            ],
        };
    }

    if (state.currentStepId === 'providers_optional') {
        return { nextStepId: 'done', effects: [] };
    }

    if (state.currentStepId === 'done') {
        return { nextStepId: null, effects: [{ type: 'exitSetup' }] };
    }

    return {
        nextStepId: getNextVisibleStepId(state, registry),
        effects: [],
    };
}

export function resolveWizardAdvance(
    state: WizardState,
    registry: WizardAdvanceRegistry,
    event: WizardAdvanceEvent,
): WizardAdvanceResolution {
    if (event.type === 'saveCustomRelayUrl') {
        return resolveSaveCustomRelayUrl(state, event);
    }

    if (state.context.mode === 'setup') {
        return resolveSetupAdvance(state, event, registry);
    }

    if (state.currentStepId === 'relay_select') {
        return resolveRelaySelectAdvance(state, event);
    }

    return {
        nextStepId: getNextVisibleStepId(state, registry),
        effects: [],
    };
}
