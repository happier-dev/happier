import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { KnownSettings } from '@/sync/domains/settings/settings';
import type { TranslationKey } from '@/text';
import { t } from '@/text';
import { INSTALLABLES_CATALOG, INSTALLABLE_KEYS, type InstallableAutoUpdateMode, type InstallableDefaultPolicy, type InstallableKey } from '@happier-dev/protocol/installables';

export type { InstallableAutoUpdateMode, InstallableDefaultPolicy };

import {
    buildCodexAcpLatestVersionDetectRequest,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    shouldPrefetchCodexAcpLatestVersion,
} from './codexAcpDep';
import {
    buildGithubCliLatestVersionDetectRequest,
    getGithubCliDepData,
    getGithubCliDetectResult,
    shouldPrefetchGithubCliLatestVersion,
} from './githubCliDep';

export type InstallableDepDataLike = {
    installed: boolean;
    installedVersion: string | null;
    sourceKind: string;
    lastInstallLogPath: string | null;
    lastBackgroundUpdateCheckAtMs: number | null;
    runtimeState?: 'downloading' | 'ready' | 'unavailable';
    latestVersionCheck?:
        | { ok: true; latestVersion: string | null; label: string | null; checkedAt?: number }
        | { ok: false; errorMessage: string; checkedAt?: number };
};

export type InstallableRegistryEntry = Readonly<{
    key: string;
    kind: 'dep';
    experimental: boolean;
    enabledWhen: (settings: KnownSettings) => boolean;
    capabilityId: Extract<CapabilityId, `dep.${string}`>;
    title: string;
    iconName: string;
    groupTitleKey: TranslationKey;
    supportsManagedOverrideInstall: boolean;
    defaultPolicy: InstallableDefaultPolicy;
    installLabels: { installKey: TranslationKey; updateKey: TranslationKey; reinstallKey: TranslationKey };
    installModal: {
        installTitleKey: TranslationKey;
        updateTitleKey: TranslationKey;
        reinstallTitleKey: TranslationKey;
        descriptionKey: TranslationKey;
    };
    getStatus: (results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined) => InstallableDepDataLike | null;
    getDetectResult: (results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined) => CapabilityDetectResult | null;
    shouldPrefetchLatestVersion: (params: {
        requireExistingResult?: boolean;
        result?: CapabilityDetectResult | null;
        data?: InstallableDepDataLike | null;
    }) => boolean;
    buildLatestVersionDetectRequest: () => CapabilitiesDetectRequest;
}>;

type InstallableUiEntry = Omit<InstallableRegistryEntry, 'key' | 'kind' | 'experimental' | 'capabilityId' | 'defaultPolicy'>;

function buildPinnedRuntimeUiEntry(params: {
    capabilityId: Extract<CapabilityId, `dep.${string}`>;
    titleKey: TranslationKey;
    descriptionKey: TranslationKey;
    iconName: string;
}): InstallableUiEntry {
    return {
        enabledWhen: () => true,
        title: t(params.titleKey),
        iconName: params.iconName,
        groupTitleKey: params.titleKey,
        supportsManagedOverrideInstall: false,
        installLabels: {
            installKey: 'deps.installable.install',
            updateKey: 'deps.installable.update',
            reinstallKey: 'deps.installable.reinstall',
        },
        installModal: {
            installTitleKey: params.titleKey,
            updateTitleKey: params.titleKey,
            reinstallTitleKey: params.titleKey,
            descriptionKey: params.descriptionKey,
        },
        getDetectResult: (results) => results?.[params.capabilityId] ?? null,
        getStatus: (results) => {
            const result = results?.[params.capabilityId];
            if (!result?.ok || !result.data || typeof result.data !== 'object') return null;
            return result.data as InstallableDepDataLike;
        },
        // Runtime archives follow the CLI version; detection only reads local install state.
        shouldPrefetchLatestVersion: () => false,
        buildLatestVersionDetectRequest: () => ({ requests: [{ id: params.capabilityId }] }),
    };
}

export function getInstallablesRegistryEntries(): readonly InstallableRegistryEntry[] {
    const uiByKey: Readonly<Record<InstallableKey, InstallableUiEntry>> = {
        [INSTALLABLE_KEYS.LOCAL_EMBEDDINGS]: buildPinnedRuntimeUiEntry({
            capabilityId: 'dep.local-embeddings',
            titleKey: 'deps.installable.localEmbeddings.title',
            descriptionKey: 'deps.installable.localEmbeddings.description',
            iconName: 'cpu',
        }),
        [INSTALLABLE_KEYS.DIFFTASTIC]: buildPinnedRuntimeUiEntry({
            capabilityId: 'dep.difftastic',
            titleKey: 'deps.installable.difftastic.title',
            descriptionKey: 'deps.installable.difftastic.description',
            iconName: 'arrows-left-right',
        }),
        [INSTALLABLE_KEYS.CODEX_ACP]: {
            enabledWhen: () => true,
            title: t('deps.installable.codexAcp.title'),
            iconName: 'arrows-left-right',
            groupTitleKey: 'newSession.codexAcpBanner.title',
            supportsManagedOverrideInstall: false,
            installLabels: {
                installKey: 'newSession.codexAcpBanner.install',
                updateKey: 'newSession.codexAcpBanner.update',
                reinstallKey: 'newSession.codexAcpBanner.reinstall',
            },
            installModal: {
                installTitleKey: 'newSession.codexAcpInstallModal.installTitle',
                updateTitleKey: 'newSession.codexAcpInstallModal.updateTitle',
                reinstallTitleKey: 'newSession.codexAcpInstallModal.reinstallTitle',
                descriptionKey: 'newSession.codexAcpInstallModal.description',
            },
            getStatus: (results) => getCodexAcpDepData(results),
            getDetectResult: (results) => getCodexAcpDetectResult(results),
            shouldPrefetchLatestVersion: ({ requireExistingResult, result, data }) =>
                shouldPrefetchCodexAcpLatestVersion({
                    requireExistingResult,
                    result,
                    data: data ?? null,
                }),
            buildLatestVersionDetectRequest: buildCodexAcpLatestVersionDetectRequest,
        },
        [INSTALLABLE_KEYS.GH]: {
            enabledWhen: () => true,
            title: t('deps.installable.githubCli.title'),
            iconName: 'git-pull-request',
            groupTitleKey: 'newSession.githubCliBanner.title',
            supportsManagedOverrideInstall: false,
            installLabels: {
                installKey: 'newSession.githubCliBanner.install',
                updateKey: 'newSession.githubCliBanner.update',
                reinstallKey: 'newSession.githubCliBanner.reinstall',
            },
            installModal: {
                installTitleKey: 'newSession.githubCliInstallModal.installTitle',
                updateTitleKey: 'newSession.githubCliInstallModal.updateTitle',
                reinstallTitleKey: 'newSession.githubCliInstallModal.reinstallTitle',
                descriptionKey: 'newSession.githubCliInstallModal.description',
            },
            getStatus: (results) => getGithubCliDepData(results),
            getDetectResult: (results) => getGithubCliDetectResult(results),
            shouldPrefetchLatestVersion: ({ requireExistingResult, result, data }) =>
                shouldPrefetchGithubCliLatestVersion({
                    requireExistingResult,
                    result,
                    data: data ?? null,
                }),
            buildLatestVersionDetectRequest: buildGithubCliLatestVersionDetectRequest,
        },
    };

    const entries: InstallableRegistryEntry[] = [];
    for (const catalogEntry of INSTALLABLES_CATALOG) {
        if (catalogEntry.kind !== 'dep') continue;
        const ui = uiByKey[catalogEntry.key as InstallableKey];
        if (!ui) continue;
        entries.push({
            key: catalogEntry.key,
            kind: 'dep',
            experimental: catalogEntry.experimental,
            capabilityId: catalogEntry.capabilityId,
            defaultPolicy: catalogEntry.defaultPolicy,
            ...ui,
        });
    }

    return entries;
}
