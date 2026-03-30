import { describe, expect, it } from 'vitest';
import { CODEX_ACP_DEP_ID, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import type { InstallableRegistryEntry, InstallableDepDataLike } from './installablesRegistry';
import { planInstallablesBackgroundActions } from './installablesBackgroundPlan';

const baseEntry: InstallableRegistryEntry = {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    kind: 'dep',
    experimental: true,
    enabledWhen: () => true,
    capabilityId: CODEX_ACP_DEP_ID,
    title: 'Codex ACP',
    iconName: 'swap-horizontal-outline',
    groupTitleKey: 'newSession.codexAcpBanner.title',
    supportsManagedOverrideInstall: false,
    defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
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
    getStatus: () => null,
    getDetectResult: () => null,
    shouldPrefetchLatestVersion: () => false,
    buildLatestVersionDetectRequest: () => ({ requests: [] }),
};

function status(data: Partial<InstallableDepDataLike>): InstallableDepDataLike {
    return {
        installed: false,
        installedVersion: null,
        sourceKind: 'github_release_binary',
        lastInstallLogPath: null,
        lastBackgroundUpdateCheckAtMs: null,
        ...data,
    };
}

describe('planInstallablesBackgroundActions', () => {
    it('plans install when missing and autoInstallWhenNeeded=true', () => {
        const actions = planInstallablesBackgroundActions({
            installables: [{
                entry: baseEntry,
                status: status({ installed: false }),
                policy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
            }],
        });
        expect(actions).toEqual([
            { installableKey: INSTALLABLE_KEYS.CODEX_ACP, request: { id: CODEX_ACP_DEP_ID, method: 'install' } },
        ]);
    });

    it('does not plan install when missing and autoInstallWhenNeeded=false', () => {
        const actions = planInstallablesBackgroundActions({
            installables: [{
                entry: baseEntry,
                status: status({ installed: false }),
                policy: { autoInstallWhenNeeded: false, autoUpdateMode: 'auto' },
            }],
        });
        expect(actions).toEqual([]);
    });

    it('plans upgrade when update available and autoUpdateMode=auto', () => {
        const actions = planInstallablesBackgroundActions({
            installables: [{
                entry: baseEntry,
                status: status({
                    installed: true,
                    installedVersion: '1.0.0',
                    latestVersionCheck: { ok: true, latestVersion: '1.0.1', label: 'v1.0.1' },
                }),
                policy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
            }],
        });
        expect(actions).toEqual([
            { installableKey: INSTALLABLE_KEYS.CODEX_ACP, request: { id: CODEX_ACP_DEP_ID, method: 'upgrade' } },
        ]);
    });

    it('does not plan upgrade when update available and autoUpdateMode=notify', () => {
        const actions = planInstallablesBackgroundActions({
            installables: [{
                entry: baseEntry,
                status: status({
                    installed: true,
                    installedVersion: '1.0.0',
                    latestVersionCheck: { ok: true, latestVersion: '1.0.1', label: 'v1.0.1' },
                }),
                policy: { autoInstallWhenNeeded: true, autoUpdateMode: 'notify' },
            }],
        });
        expect(actions).toEqual([]);
    });
});
