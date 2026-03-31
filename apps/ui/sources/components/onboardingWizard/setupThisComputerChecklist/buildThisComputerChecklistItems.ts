import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';

import type { ThisComputerChecklistItemId, ThisComputerSetupPreflight } from './types';

const BASE_ITEM_IDS: readonly ThisComputerChecklistItemId[] = [
    'setup.thisComputer.resolveRelay',
    'setup.thisComputer.checkAuth',
    'setup.thisComputer.configureRelay',
];

const AUTH_ITEM_IDS: readonly ThisComputerChecklistItemId[] = [
    'setup.thisComputer.auth.request',
    'setup.thisComputer.auth.wait',
];

const FOOTER_ITEM_IDS: readonly ThisComputerChecklistItemId[] = [
    'setup.thisComputer.installService',
    'setup.thisComputer.startService',
    'setup.thisComputer.verifyService',
];

const ITEM_TITLES: Readonly<Record<ThisComputerChecklistItemId, string>> = {
    'setup.thisComputer.resolveRelay': t('settings.machineSetupStepResolveRelay'),
    'setup.thisComputer.checkAuth': t('settings.machineSetupStepCheckAuth'),
    'setup.thisComputer.configureRelay': t('settings.machineSetupStepConfigureRelay'),
    'setup.thisComputer.auth.request': t('settings.machineSetupStepAuthRequest'),
    'setup.thisComputer.auth.wait': t('settings.machineSetupStepAuthWait'),
    'setup.thisComputer.installService': t('settings.machineSetupStepInstallService'),
    'setup.thisComputer.startService': t('settings.machineSetupStepStartService'),
    'setup.thisComputer.verifyService': t('settings.machineSetupStepVerifyService'),
};

function toRedactedId(raw: string | null): string {
    const value = String(raw ?? '').trim();
    if (!value) return t('status.unknown');
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function resolveServerMismatchSubtitle(preflight: ThisComputerSetupPreflight): string {
    if (!preflight.serverMismatch) {
        return preflight.activeRelayUrl
            ? t('setupOnboarding.currentRelayDescription', {
                relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
            })
            : t('setupOnboarding.postAuthBody');
    }

    const ui = preflight.activeRelayUrl ? toServerUrlDisplay(preflight.activeRelayUrl) : t('status.unknown');
    const machine = preflight.daemonServerUrl ? toServerUrlDisplay(preflight.daemonServerUrl) : t('status.unknown');
    return t('diagnosis.findings.serverMismatch.subtitle', { ui, machine });
}

function resolveAccountMismatchSubtitle(preflight: ThisComputerSetupPreflight): string {
    if (!preflight.accountMismatch) {
        return preflight.needsAuth || preflight.pairingRequired
            ? t('setupOnboarding.resumeIntentBody')
            : t('setupOnboarding.postAuthBody');
    }

    return t('diagnosis.findings.accountMismatch.subtitle', {
        ui: toRedactedId(preflight.uiAccountId),
        machine: toRedactedId(preflight.daemonAccountId),
    });
}

function buildChecklistItemIds(preflight: ThisComputerSetupPreflight): readonly ThisComputerChecklistItemId[] {
    return [
        ...BASE_ITEM_IDS,
        ...(preflight.pairingRequired ? AUTH_ITEM_IDS : []),
        ...FOOTER_ITEM_IDS,
    ];
}

function resolveSubtitle(id: ThisComputerChecklistItemId, preflight: ThisComputerSetupPreflight): string {
    switch (id) {
        case 'setup.thisComputer.resolveRelay':
            return preflight.activeRelayUrl
                ? t('setupOnboarding.currentRelayDescription', {
                    relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
                })
                : t('setupOnboarding.postAuthBody');
        case 'setup.thisComputer.checkAuth':
            return resolveAccountMismatchSubtitle(preflight);
        case 'setup.thisComputer.configureRelay':
            if (preflight.relayDriftBanner) {
                return preflight.relayDriftBanner.description;
            }
            return resolveServerMismatchSubtitle(preflight);
        case 'setup.thisComputer.auth.request':
            return t('setupOnboarding.resumeIntentBody');
        case 'setup.thisComputer.auth.wait':
            return t('setupOnboarding.postAuthBody');
        case 'setup.thisComputer.installService':
            return t('sessionGettingStarted.steps.daemonInstall.description');
        case 'setup.thisComputer.startService':
            return t('sessionGettingStarted.steps.daemonStart.description');
        case 'setup.thisComputer.verifyService':
            return preflight.machineId
                ? t('setupOnboarding.nextActionReady')
                : t('setupOnboarding.postAuthBody');
        default:
            return t('setupOnboarding.postAuthBody');
    }
}

function resolveDetails(id: ThisComputerChecklistItemId, preflight: ThisComputerSetupPreflight): string {
    switch (id) {
        case 'setup.thisComputer.resolveRelay':
            return preflight.activeRelayUrl
                ? t('setupOnboarding.currentRelayDescription', {
                    relayUrl: toServerUrlDisplay(preflight.activeRelayUrl),
                })
                : t('setupOnboarding.postAuthBody');
        case 'setup.thisComputer.checkAuth':
            if (preflight.accountMismatch) {
                return t('diagnosis.findings.accountMismatch.steps.signInSameAccount');
            }
            return preflight.needsAuth || preflight.pairingRequired
                ? t('setupOnboarding.resumeIntentBody')
                : t('setupOnboarding.postAuthBody');
        case 'setup.thisComputer.configureRelay':
            if (preflight.relayDriftBanner) {
                return preflight.relayDriftBanner.description;
            }
            if (preflight.serverMismatch) {
                return t('diagnosis.findings.serverMismatch.steps.switchUiServer');
            }
            return resolveServerMismatchSubtitle(preflight);
        case 'setup.thisComputer.auth.request':
            return t('setupOnboarding.resumeIntentBody');
        case 'setup.thisComputer.auth.wait':
            return t('setupOnboarding.postAuthBody');
        case 'setup.thisComputer.installService':
            return preflight.serviceInstalled
                ? t('common.done')
                : t('sessionGettingStarted.steps.startDaemonInstall.description');
        case 'setup.thisComputer.startService':
            return preflight.daemonRunning
                ? t('common.done')
                : t('sessionGettingStarted.steps.daemonStart.description');
        case 'setup.thisComputer.verifyService':
            return preflight.machineId
                ? t('setupOnboarding.nextActionReady')
                : t('settings.machineSetupStepVerifyService');
        default:
            return t('setupOnboarding.postAuthBody');
    }
}

function resolveSatisfied(id: ThisComputerChecklistItemId, preflight: ThisComputerSetupPreflight): boolean {
    switch (id) {
        case 'setup.thisComputer.resolveRelay':
            return Boolean(preflight.activeRelayUrl);
        case 'setup.thisComputer.checkAuth':
            return !preflight.needsAuth && !preflight.accountMismatch && !preflight.pairingRequired;
        case 'setup.thisComputer.configureRelay':
            return !preflight.serverMismatch && preflight.relayDriftBanner == null && Boolean(preflight.activeRelayUrl);
        case 'setup.thisComputer.auth.request':
        case 'setup.thisComputer.auth.wait':
            return false;
        case 'setup.thisComputer.installService':
            return preflight.serviceInstalled;
        case 'setup.thisComputer.startService':
            return preflight.daemonRunning;
        case 'setup.thisComputer.verifyService':
            return Boolean(preflight.machineId);
        default:
            return false;
    }
}

export function buildThisComputerChecklistItems(preflight: ThisComputerSetupPreflight): readonly PlanChecklistItem[] {
    return buildChecklistItemIds(preflight).map((id) => {
        const satisfied = resolveSatisfied(id, preflight);
        const isServiceItem = FOOTER_ITEM_IDS.includes(id);
        const disabled = satisfied ? true : (isServiceItem ? false : true);
        return {
            id,
            title: ITEM_TITLES[id],
            subtitle: resolveSubtitle(id, preflight),
            satisfied,
            disabled,
            defaultSelected: true,
            badge: id === 'setup.thisComputer.configureRelay' && (preflight.relayDriftBanner || preflight.serverMismatch)
                ? t('systemStatus.mismatch')
                : id === 'setup.thisComputer.checkAuth' && preflight.accountMismatch
                    ? t('systemStatus.mismatch')
                : (satisfied ? t('common.done') : undefined),
            details: resolveDetails(id, preflight),
        } satisfies PlanChecklistItem;
    });
}
