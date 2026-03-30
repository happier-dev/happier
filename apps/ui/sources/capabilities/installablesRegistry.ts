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

export type InstallableDepDataLike = {
    installed: boolean;
    installedVersion: string | null;
    sourceKind: string;
    lastInstallLogPath: string | null;
    lastBackgroundUpdateCheckAtMs: number | null;
    latestVersionCheck?: { ok: true; latestVersion: string | null; label: string | null } | { ok: false; errorMessage: string };
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

export function getInstallablesRegistryEntries(): readonly InstallableRegistryEntry[] {
    const uiByKey: Readonly<Record<InstallableKey, Omit<InstallableRegistryEntry, 'key' | 'kind' | 'experimental' | 'capabilityId' | 'defaultPolicy'>>> = {
        [INSTALLABLE_KEYS.CODEX_ACP]: {
            enabledWhen: () => true,
            title: t('deps.installable.codexAcp.title'),
            iconName: 'swap-horizontal-outline',
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
