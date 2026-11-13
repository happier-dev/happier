import type {
    WizardRelaySelection,
    WizardState,
    WizardStepDefinition,
    WizardStepId,
} from './wizardTypes';

export type WizardCloudRelay = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

export type WizardAdvanceRegistry = readonly Pick<WizardStepDefinition, 'id' | 'visibleWhen'>[];

export type WizardAdvanceEvent =
    | Readonly<{
        type: 'primary';
        isDesktopShell?: boolean;
        activeServerMatchesSelectedRelay?: boolean;
        cloudRelay?: WizardCloudRelay | null;
        relayUrlForIntent?: string | null;
    }>
    | Readonly<{
        type: 'saveCustomRelayUrl';
        relayUrl: string;
    }>;

export type WizardAdvanceEffect =
    | Readonly<{
        type: 'activateServerUrl';
        serverUrl: string;
        source: 'url';
    }>
    | Readonly<{
        type: 'activateServerProfile';
        serverId: string;
    }>
    | Readonly<{
        type: 'setRelaySelection';
        relaySelection: WizardRelaySelection;
    }>
    | Readonly<{
        type: 'persistOnboardingIntent';
        relayUrl: string | null;
    }>
    | Readonly<{ type: 'clearRelayAccessDraft' }>;

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
        // A new address is connected in the Welcome's connect step; a saved Home is selected here.
        const serverUrl = trimmed(selection.serverUrl);
        if (!selection.relayProfileId || !serverUrl) {
            return { nextStepId: 'connect_home', effects: intentEffect };
        }

        const effects: WizardAdvanceEffect[] = [...intentEffect];
        if (event.activeServerMatchesSelectedRelay === false) {
            effects.push({
                type: 'activateServerUrl',
                serverUrl,
                source: 'url',
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

/** The web "this computer" handoff: the address of the Home this computer runs, then its background service. */
function resolveSaveCustomRelayUrl(
    event: Extract<WizardAdvanceEvent, { type: 'saveCustomRelayUrl' }>,
): WizardAdvanceResolution {
    const relayUrl = trimmed(event.relayUrl);
    return {
        nextStepId: 'background_service_handoff',
        effects: [
            {
                type: 'activateServerUrl',
                serverUrl: relayUrl,
                source: 'url',
            },
            { type: 'clearRelayAccessDraft' },
            {
                type: 'setRelaySelection',
                relaySelection: {
                    choiceId: 'thisComputer',
                    serverUrl: relayUrl,
                    relayProfileId: null,
                    locked: false,
                },
            },
            { type: 'persistOnboardingIntent', relayUrl },
        ],
    };
}

export function resolveWizardAdvance(
    state: WizardState,
    registry: WizardAdvanceRegistry,
    event: WizardAdvanceEvent,
): WizardAdvanceResolution {
    if (event.type === 'saveCustomRelayUrl') {
        return resolveSaveCustomRelayUrl(event);
    }

    if (state.currentStepId === 'relay_select') {
        return resolveRelaySelectAdvance(state, event);
    }

    return {
        nextStepId: getNextVisibleStepId(state, registry),
        effects: [],
    };
}
