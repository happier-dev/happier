import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { KnownSettings } from '@/sync/domains/settings/settings';
import type { TranslationKey } from '@/text';
import type { CodexAcpDepData, CodexMcpResumeDepData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';
import { INSTALLABLES_CATALOG, INSTALLABLE_KEYS, type InstallableAutoUpdateMode, type InstallableDefaultPolicy, type InstallableKey } from '@happier-dev/protocol/installables';

export type { InstallableAutoUpdateMode, InstallableDefaultPolicy };

import {
    buildCodexMcpResumeRegistryDetectRequest,
    getCodexMcpResumeDepData,
    getCodexMcpResumeDetectResult,
    shouldPrefetchCodexMcpResumeRegistry,
} from './codexMcpResume';
import {
    buildCodexAcpRegistryDetectRequest,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    shouldPrefetchCodexAcpRegistry,
} from './codexAcpDep';

type SettingsKey = Extract<keyof KnownSettings, string>;

export type InstallSpecSettingKey = {
    [K in SettingsKey]: KnownSettings[K] extends string | null ? K : never;
}[SettingsKey] | 'codexMcpResumeInstallSpec' | 'codexAcpInstallSpec';

export type InstallableDepDataLike = {
    installed: boolean;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
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
    installSpecSettingKey: InstallSpecSettingKey;
    installSpecTitle: string;
    installSpecDescription: string;
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
    shouldPrefetchRegistry: (params: {
        requireExistingResult?: boolean;
        result?: CapabilityDetectResult | null;
        data?: InstallableDepDataLike | null;
    }) => boolean;
    buildRegistryDetectRequest: () => CapabilitiesDetectRequest;
}>;

export function getInstallablesRegistryEntries(): readonly InstallableRegistryEntry[] {
    const uiByKey: Readonly<Record<InstallableKey, Omit<InstallableRegistryEntry, 'key' | 'kind' | 'experimental' | 'capabilityId' | 'defaultPolicy'>>> = {
        [INSTALLABLE_KEYS.CODEX_MCP_RESUME]: {
            enabledWhen: () => true,
            title: t('deps.installable.codexResume.title'),
            iconName: 'refresh-circle-outline',
            groupTitleKey: 'newSession.codexResumeBanner.title',
            installSpecSettingKey: 'codexMcpResumeInstallSpec',
            installSpecTitle: t('deps.installable.codexResume.installSpecTitle'),
            installSpecDescription: t('deps.installable.installSpecDescription'),
            installLabels: {
                installKey: 'newSession.codexResumeBanner.install',
                updateKey: 'newSession.codexResumeBanner.update',
                reinstallKey: 'newSession.codexResumeBanner.reinstall',
            },
            installModal: {
                installTitleKey: 'newSession.codexResumeInstallModal.installTitle',
                updateTitleKey: 'newSession.codexResumeInstallModal.updateTitle',
                reinstallTitleKey: 'newSession.codexResumeInstallModal.reinstallTitle',
                descriptionKey: 'newSession.codexResumeInstallModal.description',
            },
            getStatus: (results) => getCodexMcpResumeDepData(results) as unknown as CodexMcpResumeDepData | null,
            getDetectResult: (results) => getCodexMcpResumeDetectResult(results),
            shouldPrefetchRegistry: ({ requireExistingResult, result, data }) =>
                shouldPrefetchCodexMcpResumeRegistry({
                    requireExistingResult,
                    result,
                    data: data as any,
                }),
            buildRegistryDetectRequest: buildCodexMcpResumeRegistryDetectRequest,
        },
        [INSTALLABLE_KEYS.CODEX_ACP]: {
            enabledWhen: () => true,
            title: t('deps.installable.codexAcp.title'),
            iconName: 'swap-horizontal-outline',
            groupTitleKey: 'newSession.codexAcpBanner.title',
            installSpecSettingKey: 'codexAcpInstallSpec',
            installSpecTitle: t('deps.installable.codexAcp.installSpecTitle'),
            installSpecDescription: t('deps.installable.installSpecDescription'),
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
            getStatus: (results) => getCodexAcpDepData(results) as unknown as CodexAcpDepData | null,
            getDetectResult: (results) => getCodexAcpDetectResult(results),
            shouldPrefetchRegistry: ({ requireExistingResult, result, data }) =>
                shouldPrefetchCodexAcpRegistry({
                    requireExistingResult,
                    result,
                    data: data as any,
                }),
            buildRegistryDetectRequest: buildCodexAcpRegistryDetectRequest,
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
