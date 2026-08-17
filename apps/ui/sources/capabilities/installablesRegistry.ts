import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { KnownSettings } from '@/sync/domains/settings/settings';
import type { TranslationKey } from '@/text';
import { t } from '@/text';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import {
    GH_DEP_ID,
    INSTALLABLES_CATALOG,
    INSTALLABLE_KEYS,
    type InstallableAutoUpdateMode,
    type InstallableDefaultPolicy,
    type InstallableKey,
    type InstallableProjectionEntry,
} from '@happier-dev/protocol/installables';

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

export type InstallablesRegistryProjectionInput = Readonly<{
    pluginProjection?: Pick<PluginProjectionV2, 'familiesById'>;
    projectedInstallables?: readonly InstallableProjectionEntry[];
}>;

function getInstallableDetectResult(
    capabilityId: Extract<CapabilityId, `dep.${string}`>,
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CapabilityDetectResult | null {
    const result = results?.[capabilityId];
    return result ? result : null;
}

function getInstallableDepData(
    capabilityId: Extract<CapabilityId, `dep.${string}`>,
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): InstallableDepDataLike | null {
    const result = getInstallableDetectResult(capabilityId, results);
    if (!result || result.ok !== true) return null;
    const data = result.data;
    return data && typeof data === 'object' ? data as InstallableDepDataLike : null;
}

function getLatestVersionCheckedAt(
    result: CapabilityDetectResult | null,
    latestVersionCheck: InstallableDepDataLike['latestVersionCheck'],
): number {
    const durableCheckedAt = latestVersionCheck && typeof latestVersionCheck.checkedAt === 'number'
        ? latestVersionCheck.checkedAt
        : 0;
    if (durableCheckedAt > 0) return durableCheckedAt;
    return result && typeof result.checkedAt === 'number' ? result.checkedAt : 0;
}

function shouldPrefetchInstallableLatestVersion(params: {
    result?: CapabilityDetectResult | null;
    data?: InstallableDepDataLike | null;
    requireExistingResult?: boolean;
}): boolean {
    const okStaleMs = 24 * 60 * 60 * 1000;
    const errorRetryMs = 30 * 60 * 1000;
    const result = params.result ?? null;
    const data = params.data ?? null;
    const requireExistingResult = params.requireExistingResult === true;

    if (!result || result.ok !== true) {
        return requireExistingResult ? false : true;
    }

    if (!data || data.installed !== true) {
        return requireExistingResult ? false : true;
    }

    const latestVersionCheck = data.latestVersionCheck;
    const checkedAt = getLatestVersionCheckedAt(result, latestVersionCheck);
    if (!latestVersionCheck) return true;
    if (checkedAt <= 0) return true;

    const threshold = latestVersionCheck.ok === true ? okStaleMs : errorRetryMs;
    return Date.now() - checkedAt > threshold;
}

function buildLatestVersionDetectRequest(
    capabilityId: Extract<CapabilityId, `dep.${string}`>,
): CapabilitiesDetectRequest {
    return {
        requests: [{
            id: capabilityId,
            params: { includeLatestVersion: true, onlyIfInstalled: true },
        }],
    };
}

function buildGenericInstallableUi(
    projected: InstallableProjectionEntry,
): Omit<InstallableRegistryEntry, 'key' | 'kind' | 'experimental' | 'capabilityId' | 'defaultPolicy'> {
    const capabilityId = projected.capabilityId as Extract<CapabilityId, `dep.${string}`>;
    return {
        enabledWhen: () => true,
        title: projected.display.name,
        iconName: 'terminal',
        groupTitleKey: 'machine.tools.installablesTitle',
        supportsManagedOverrideInstall: false,
        installLabels: {
            installKey: 'common.install',
            updateKey: 'common.update',
            reinstallKey: 'newSession.codexAcpBanner.reinstall',
        },
        installModal: {
            installTitleKey: 'newSession.codexAcpInstallModal.installTitle',
            updateTitleKey: 'newSession.codexAcpInstallModal.updateTitle',
            reinstallTitleKey: 'newSession.codexAcpInstallModal.reinstallTitle',
            descriptionKey: 'newSession.codexAcpInstallModal.description',
        },
        getStatus: (results) => getInstallableDepData(capabilityId, results),
        getDetectResult: (results) => getInstallableDetectResult(capabilityId, results),
        shouldPrefetchLatestVersion: ({ requireExistingResult, result, data }) =>
            shouldPrefetchInstallableLatestVersion({
                requireExistingResult,
                result,
                data: data ?? null,
            }),
        buildLatestVersionDetectRequest: () => buildLatestVersionDetectRequest(capabilityId),
    };
}

function readInstallableProjectionInputs(
    params: InstallablesRegistryProjectionInput | undefined,
): readonly InstallableProjectionEntry[] {
    const catalogEntries = INSTALLABLES_CATALOG.map((entry) => ({
        id: entry.key,
        key: entry.key,
        capabilityId: entry.capabilityId,
        sourceKind: entry.sourceKind,
        display: {
            name: entry.key,
        },
        defaultPolicy: entry.defaultPolicy,
        experimental: entry.experimental,
    }));
    const projectedInstallables = params?.projectedInstallables ?? readPluginProjectionInstallables(params?.pluginProjection);
    if (projectedInstallables) {
        return projectedInstallables;
    }
    return catalogEntries;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readPluginProjectionInstallables(
    pluginProjection: Pick<PluginProjectionV2, 'familiesById'> | undefined,
): readonly InstallableProjectionEntry[] | null {
    const entries = pluginProjection?.familiesById.managedDependencies?.entriesById;
    if (!entries) return null;
    return Object.values(entries).flatMap((value) => {
        const entry = readRecord(value);
        if (!entry) return [];

        const id = readString(entry.id);
        const key = readString(entry.key);
        const capabilityId = readString(entry.capabilityId);
        const sourceKind = readString(entry.sourceKind);
        const display = readRecord(entry.display);
        const name = display ? readString(display.name) : null;
        const subtitle = display ? readString(display.subtitle) : null;
        const defaultPolicy = readRecord(entry.defaultPolicy);
        const autoInstallWhenNeeded = defaultPolicy?.autoInstallWhenNeeded;
        const autoUpdateMode = readString(defaultPolicy?.autoUpdateMode);
        if (!id || !key || !capabilityId || !sourceKind || !name || typeof autoInstallWhenNeeded !== 'boolean' || !autoUpdateMode) {
            return [];
        }

        return [{
            id,
            ...(readString(entry.pluginId) ? { pluginId: readString(entry.pluginId)! } : {}),
            key,
            capabilityId,
            sourceKind,
            display: {
                name,
                ...(subtitle ? { subtitle } : {}),
            },
            defaultPolicy: {
                autoInstallWhenNeeded,
                autoUpdateMode,
            },
            experimental: entry.experimental === true,
        }];
    });
}

export function getInstallablesRegistryEntries(
    params?: InstallablesRegistryProjectionInput,
): readonly InstallableRegistryEntry[] {
    const uiByKey: Readonly<Record<InstallableKey, Omit<InstallableRegistryEntry, 'key' | 'kind' | 'experimental' | 'capabilityId' | 'defaultPolicy'>>> = {
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
            title: t('deps.installable.gh.title'),
            iconName: 'github-logo',
            groupTitleKey: 'newSession.ghCliBanner.title',
            supportsManagedOverrideInstall: true,
            installLabels: {
                installKey: 'newSession.ghCliBanner.install',
                updateKey: 'newSession.ghCliBanner.update',
                reinstallKey: 'newSession.ghCliBanner.reinstall',
            },
            installModal: {
                installTitleKey: 'newSession.ghCliInstallModal.installTitle',
                updateTitleKey: 'newSession.ghCliInstallModal.updateTitle',
                reinstallTitleKey: 'newSession.ghCliInstallModal.reinstallTitle',
                descriptionKey: 'newSession.ghCliInstallModal.description',
            },
            getStatus: (results) => getInstallableDepData(GH_DEP_ID, results),
            getDetectResult: (results) => getInstallableDetectResult(GH_DEP_ID, results),
            shouldPrefetchLatestVersion: ({ requireExistingResult, result, data }) =>
                shouldPrefetchInstallableLatestVersion({
                    requireExistingResult,
                    result,
                    data: data ?? null,
                }),
            buildLatestVersionDetectRequest: () => buildLatestVersionDetectRequest(GH_DEP_ID),
        },
    };

    const entries: InstallableRegistryEntry[] = [];
    for (const projected of readInstallableProjectionInputs(params)) {
        const ui = uiByKey[projected.key as InstallableKey] ?? buildGenericInstallableUi(projected);
        if (!ui) continue;
        entries.push({
            key: projected.key,
            kind: 'dep',
            experimental: projected.experimental,
            capabilityId: projected.capabilityId as Extract<CapabilityId, `dep.${string}`>,
            defaultPolicy: projected.defaultPolicy as InstallableDefaultPolicy,
            ...ui,
        });
    }

    return entries;
}
