import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import type { ThisComputerSetupPreflight } from '@/components/onboarding/checklists/setupThisComputer/types';
import type { ThisComputerSetupPrompt } from './resolveThisComputerSetupPrompt';

export type ThisComputerSetupStageId =
    | 'setup.thisComputer.stage.installTools'
    | 'setup.thisComputer.stage.useRelay'
    | 'setup.thisComputer.stage.registerComputer'
    | 'setup.thisComputer.stage.backgroundService';

function isReady(preflight: ThisComputerSetupPreflight): boolean {
    return Boolean(
        preflight.activeRelayUrl
        && !preflight.needsAuth
        && !preflight.accountMismatch
        && !preflight.serverMismatch
        && !preflight.pairingRequired
        && !preflight.relayDriftBanner
        && preflight.serviceInstalled
        && preflight.daemonRunning
        && preflight.machineId,
    );
}

function hasInstalledTools(preflight: ThisComputerSetupPreflight): boolean {
    return preflight.localCliReady === true;
}

function installToolsSubtitle(preflight: ThisComputerSetupPreflight): string {
    return hasInstalledTools(preflight)
        ? t('setupOnboarding.thisComputerStages.installToolsReadySubtitle')
        : t('setupOnboarding.thisComputerStages.installToolsSubtitle');
}

function relayStageSubtitle(preflight: ThisComputerSetupPreflight): string {
    if (preflight.accountMismatch) {
        return t('setupOnboarding.thisComputerStages.useRelayAccountMismatchSubtitle');
    }
    if (preflight.needsAuth) {
        return t('setupOnboarding.thisComputerStages.useRelayNeedsAuthSubtitle');
    }
    if (preflight.relayDriftBanner) {
        return preflight.relayDriftBanner.description;
    }
    if (preflight.serverMismatch) {
        return t('setupOnboarding.thisComputerStages.useRelayServerMismatchSubtitle', {
            activeRelayUrl: preflight.activeRelayUrl ? toServerUrlDisplay(preflight.activeRelayUrl) : t('status.unknown'),
            daemonRelayUrl: preflight.daemonServerUrl ? toServerUrlDisplay(preflight.daemonServerUrl) : t('status.unknown'),
        });
    }
    if (preflight.activeRelayUrl) {
        return t('setupOnboarding.thisComputerStages.useRelayConnectedSubtitle', {
            relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
        });
    }
    return t('setupOnboarding.thisComputerStages.useRelayMissingSubtitle');
}

function isRelayReady(preflight: ThisComputerSetupPreflight): boolean {
    return Boolean(
        preflight.activeRelayUrl
        && !preflight.needsAuth
        && !preflight.accountMismatch
        && !preflight.serverMismatch
        && !preflight.relayDriftBanner,
    );
}

function resolveBackgroundServiceDecisionDetails(prompt: ThisComputerSetupPrompt | null): string | undefined {
    if (!prompt) {
        return undefined;
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        return [
            prompt.targetServerUrl,
            prompt.currentDefaultReleaseChannel ? `${prompt.currentDefaultReleaseChannel} → ${prompt.targetReleaseChannel}` : prompt.targetReleaseChannel,
        ].filter(Boolean).join('\n');
    }

    if (prompt.kind === 'daemon.takeOverManualRelayRuntimeForSetup') {
        return [
            prompt.targetServerUrl,
            prompt.targetReleaseChannel,
            prompt.currentReleaseChannel && prompt.currentCliVersion
                ? `${prompt.currentReleaseChannel} • ${prompt.currentCliVersion}`
                : prompt.currentReleaseChannel ?? prompt.currentCliVersion ?? null,
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');
    }

    const serviceLabels = prompt.services.map((service) => `${service.label} • ${service.serverUrl}`).join('\n');
    return [
        `${prompt.targetReleaseChannel} • ${prompt.targetServerUrl}`,
        serviceLabels,
    ].filter((value) => value.trim().length > 0).join('\n');
}

function registerComputerSubtitle(preflight: ThisComputerSetupPreflight): string {
    if (preflight.machineId) {
        return t('setupOnboarding.thisComputerStages.registerComputerDoneSubtitle');
    }
    if (preflight.needsAuth) {
        return t('setupOnboarding.thisComputerStages.registerComputerNeedsAuthSubtitle');
    }
    if (preflight.serverMismatch || preflight.relayDriftBanner) {
        return t('setupOnboarding.thisComputerStages.registerComputerReconnectSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.registerComputerSubtitle');
}

function backgroundServiceSubtitle(
    preflight: ThisComputerSetupPreflight,
    prompt: ThisComputerSetupPrompt | null,
): string {
    if (prompt) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceDecisionSubtitle');
    }
    if (preflight.serviceInstalled && preflight.daemonRunning) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceRunningSubtitle');
    }
    if (preflight.serviceInstalled) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceInstalledSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.backgroundServiceSubtitle');
}

function createStageChild(params: Readonly<{
    id: string;
    title: string;
    satisfied: boolean;
    details?: PlanChecklistItem['details'];
    disabled?: boolean;
    defaultSelected?: boolean;
}>): PlanChecklistItem {
    return {
        id: params.id,
        kind: 'substep',
        title: params.title,
        details: params.details,
        satisfied: params.satisfied,
        disabled: params.disabled ?? true,
        defaultSelected: params.defaultSelected ?? true,
    };
}

function installToolsChildDetails(preflight: ThisComputerSetupPreflight): string {
    return hasInstalledTools(preflight)
        ? t('setupOnboarding.thisComputerStages.installToolsReadySubtitle')
        : t('setupOnboarding.thisComputerStages.installToolsDetails');
}

function resolveRelayChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.relayDriftBanner) {
        return preflight.relayDriftBanner.description;
    }
    if (preflight.serverMismatch) {
        return t('setupOnboarding.thisComputerStages.useRelayServerMismatchSubtitle', {
            activeRelayUrl: preflight.activeRelayUrl ? toServerUrlDisplay(preflight.activeRelayUrl) : t('status.unknown'),
            daemonRelayUrl: preflight.daemonServerUrl ? toServerUrlDisplay(preflight.daemonServerUrl) : t('status.unknown'),
        });
    }
    if (preflight.activeRelayUrl) {
        return t('setupOnboarding.thisComputerStages.useRelayConnectedSubtitle', {
            relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
        });
    }
    return t('setupOnboarding.thisComputerStages.useRelayMissingSubtitle');
}

function signInChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.accountMismatch) {
        return t('setupOnboarding.thisComputerStages.useRelayAccountMismatchSubtitle');
    }
    if (preflight.needsAuth) {
        return t('setupOnboarding.thisComputerStages.useRelayNeedsAuthSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.useRelaySignedInSubtitle');
}

function configureRelayChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.relayDriftBanner || preflight.serverMismatch) {
        return resolveRelayChildDetails(preflight);
    }
    if (preflight.activeRelayUrl) {
        return t('setupOnboarding.thisComputerStages.useRelayConnectedSubtitle', {
            relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
        });
    }
    return t('setupOnboarding.thisComputerStages.useRelayDetails');
}

function registerRequestChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.machineId) {
        return t('setupOnboarding.thisComputerStages.registerComputerDoneSubtitle');
    }
    if (preflight.needsAuth) {
        return t('setupOnboarding.thisComputerStages.registerComputerNeedsAuthSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.registerComputerSubtitle');
}

function registerWaitChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.machineId) {
        return t('setupOnboarding.thisComputerStages.registerComputerDoneSubtitle');
    }
    if (preflight.needsAuth) {
        return t('setupOnboarding.thisComputerStages.registerComputerNeedsAuthSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.registerComputerDetails');
}

function installServiceChildDetails(preflight: ThisComputerSetupPreflight): string {
    return preflight.serviceInstalled
        ? t('setupOnboarding.thisComputerStages.backgroundServiceInstalledSubtitle')
        : t('setupOnboarding.thisComputerStages.backgroundServiceDetails');
}

function startServiceChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (preflight.daemonRunning) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceRunningSubtitle');
    }
    if (preflight.serviceInstalled) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceInstalledSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.backgroundServiceSubtitle');
}

function verifyServiceChildDetails(preflight: ThisComputerSetupPreflight): string {
    if (isReady(preflight)) {
        return t('setupOnboarding.thisComputerStages.backgroundServiceRunningSubtitle');
    }
    return t('setupOnboarding.thisComputerStages.backgroundServiceDetails');
}

function buildBackgroundServiceDecisionChildren(prompt: ThisComputerSetupPrompt | null): readonly PlanChecklistItem[] {
    if (!prompt) {
        return [];
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        return [
            createStageChild({
                id: 'setup.thisComputer.preflight.releaseChannel',
                title: t('setupOnboarding.thisComputerStages.backgroundServiceReleaseChannelChildTitle'),
                satisfied: false,
                details: resolveBackgroundServiceDecisionDetails(prompt)
                    ?? t('setupOnboarding.thisComputerStages.backgroundServiceDetails'),
            }),
        ];
    }

    if (prompt.kind === 'daemon.takeOverManualRelayRuntimeForSetup') {
        return [
            createStageChild({
                id: 'setup.thisComputer.preflight.manualRelayTakeover',
                title: t('setupOnboarding.thisComputerStages.backgroundServiceConflictChildTitle'),
                satisfied: false,
                details: resolveBackgroundServiceDecisionDetails(prompt)
                    ?? t('setupOnboarding.thisComputerStages.backgroundServiceDetails'),
            }),
        ];
    }

    return [
        createStageChild({
            id: 'setup.thisComputer.preflight.serviceConflict',
            title: t('setupOnboarding.thisComputerStages.backgroundServiceConflictChildTitle'),
            satisfied: false,
            details: resolveBackgroundServiceDecisionDetails(prompt)
                ?? t('setupOnboarding.thisComputerStages.backgroundServiceDetails'),
        }),
    ];
}

export function buildThisComputerSetupStageModel(params: Readonly<{
    preflight: ThisComputerSetupPreflight;
    prompt: ThisComputerSetupPrompt | null;
}>): readonly PlanChecklistItem[] {
    const { preflight, prompt } = params;
    const ready = isReady(preflight);
    const toolsInstalled = hasInstalledTools(preflight);
    const relayReady = isRelayReady(preflight);
    const backgroundServiceOwnershipResolved = prompt == null;
    const backgroundServiceReady = backgroundServiceOwnershipResolved
        && preflight.serviceInstalled
        && preflight.daemonRunning
        && !preflight.needsAuth;
    const backgroundServiceDecisionChildren = buildBackgroundServiceDecisionChildren(prompt);

    return [
        {
            id: 'setup.thisComputer.stage.installTools',
            kind: 'stage',
            title: t('setupOnboarding.thisComputerStages.installToolsTitle'),
            subtitle: installToolsSubtitle(preflight),
            details: t('setupOnboarding.thisComputerStages.installToolsDetails'),
            satisfied: toolsInstalled,
            disabled: true,
            defaultSelected: true,
            children: [
                createStageChild({
                    id: 'setup.thisComputer.ensureCli',
                    title: t('setupOnboarding.thisComputerStages.installToolsChildTitle'),
                    satisfied: toolsInstalled,
                    details: installToolsChildDetails(preflight),
                }),
            ],
        },
        {
            id: 'setup.thisComputer.stage.useRelay',
            kind: 'stage',
            title: t('setupOnboarding.thisComputerStages.useRelayTitle'),
            subtitle: relayStageSubtitle(preflight),
            details: t('setupOnboarding.thisComputerStages.useRelayDetails'),
            satisfied: relayReady,
            disabled: true,
            defaultSelected: true,
            children: [
                createStageChild({
                    id: 'setup.thisComputer.resolveRelay',
                    title: t('settings.machineSetupStepResolveRelay'),
                    satisfied: relayReady || Boolean(preflight.activeRelayUrl),
                    details: resolveRelayChildDetails(preflight),
                }),
                createStageChild({
                    id: 'setup.thisComputer.checkAuth',
                    title: t('settings.machineSetupStepCheckAuth'),
                    satisfied: relayReady || !preflight.needsAuth,
                    details: signInChildDetails(preflight),
                }),
                createStageChild({
                    id: 'setup.thisComputer.configureRelay',
                    title: t('settings.machineSetupStepConfigureRelay'),
                    satisfied: relayReady,
                    details: configureRelayChildDetails(preflight),
                }),
            ],
        },
        {
            id: 'setup.thisComputer.stage.registerComputer',
            kind: 'stage',
            title: t('setupOnboarding.thisComputerStages.registerComputerTitle'),
            subtitle: registerComputerSubtitle(preflight),
            details: t('setupOnboarding.thisComputerStages.registerComputerDetails'),
            satisfied: Boolean(preflight.machineId),
            disabled: true,
            defaultSelected: true,
            children: [
                createStageChild({
                    id: 'setup.thisComputer.auth.request',
                    title: t('settings.machineSetupStepAuthRequest'),
                    satisfied: Boolean(preflight.machineId),
                    details: registerRequestChildDetails(preflight),
                }),
                createStageChild({
                    id: 'setup.thisComputer.auth.wait',
                    title: t('settings.machineSetupStepAuthWait'),
                    satisfied: Boolean(preflight.machineId),
                    details: registerWaitChildDetails(preflight),
                }),
            ],
        },
        {
            id: 'setup.thisComputer.stage.backgroundService',
            kind: 'stage',
            title: t('setupOnboarding.thisComputerStages.backgroundServiceTitle'),
            subtitle: backgroundServiceSubtitle(preflight, prompt),
            details: resolveBackgroundServiceDecisionDetails(prompt)
                ?? t('setupOnboarding.thisComputerStages.backgroundServiceDetails'),
            satisfied: backgroundServiceReady,
            disabled: true,
            defaultSelected: true,
            badge: prompt ? t('status.actionRequired') : undefined,
            children: [
                ...backgroundServiceDecisionChildren,
                createStageChild({
                    id: 'setup.thisComputer.installService',
                    title: t('settings.machineSetupStepInstallService'),
                    satisfied: preflight.serviceInstalled,
                    disabled: false,
                    details: installServiceChildDetails(preflight),
                }),
                createStageChild({
                    id: 'setup.thisComputer.startService',
                    title: t('settings.machineSetupStepStartService'),
                    satisfied: preflight.daemonRunning,
                    details: startServiceChildDetails(preflight),
                }),
                createStageChild({
                    id: 'setup.thisComputer.verifyService',
                    title: t('settings.machineSetupStepVerifyService'),
                    satisfied: ready,
                    details: verifyServiceChildDetails(preflight),
                }),
            ],
        },
    ] satisfies readonly PlanChecklistItem[];
}
