import { describe, expect, it } from 'vitest';
import { createFeatureDecision } from '@happier-dev/protocol';

import {
    resolvePluginUiProjectionHostRuntime,
    resolveReactNativeRepackLoaderBackendAvailability,
} from './hostRuntime';

describe('plugin UI projection host runtime', () => {
    it('uses host-reported ScriptManager readiness without consulting the daemon package graph', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            installedArtifactLoaderAvailable: true,
            scriptManagerRuntimeIntegrated: true,
        })).toEqual({
            available: true,
            diagnostics: [],
        });
    });

    it('does not report loader readiness from installed-artifact loader availability alone', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            installedArtifactLoaderAvailable: false,
        })).toEqual({
            available: false,
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_installed_artifact_loader_unavailable',
            ],
            unavailableReason: 'The native host installed-artifact module loader is not wired',
        });
    });

    it('does not report loader readiness until the native ScriptManager runtime is explicitly integrated', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            installedArtifactLoaderAvailable: true,
        })).toEqual({
            available: false,
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
            unavailableReason: 'Re.Pack ScriptManager runtime is not integrated into the native host app',
        });
    });

    it('projects host runtime loader availability only from proven Re.Pack loadability', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: true,
            scriptManagerRuntimeIntegrated: true,
            reactNativeHostRuntime: {
                platform: 'ios',
                channel: 'internal',
            },
        }).reactNativeBundles?.loaderBackendAvailable).toBe(true);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: false,
        }).reactNativeBundles?.loaderBackendAvailable).toBe(false);
    });

    it('does not report loader readiness until the active native runtime identity is known', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: true,
            scriptManagerRuntimeIntegrated: true,
        }).reactNativeBundles).toMatchObject({
            loaderBackendAvailable: false,
            loaderBackendDiagnostics: [
                'repack_script_manager_unavailable',
                'react_native_host_runtime_identity_unavailable',
            ],
        });
    });

    it('uses explicit web loader readiness without consulting native Re.Pack availability', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            reactNativeWebLoaderCapability: {
                integrated: true,
                installedArtifactLoaderAvailable: true,
            },
        }).reactNativeBundles).toMatchObject({
            loaderBackendAvailable: true,
            hostRuntime: { platform: 'web', channel: 'internal' },
        });

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            reactNativeWebLoaderCapability: {
                integrated: true,
                installedArtifactLoaderAvailable: false,
            },
        }).reactNativeBundles).toMatchObject({
            loaderBackendAvailable: false,
            loaderBackendDiagnostics: [
                'react_native_web_loader_unavailable',
                'react_native_web_installed_artifact_loader_unavailable',
            ],
        });
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            reactNativeWebLoaderCapability: {
                integrated: false,
                installedArtifactLoaderAvailable: false,
            },
        }).reactNativeBundles?.loaderBackendAvailable).toBe(false);
    });

    it('does not enable React Native bundles without the canonical feature decision being enabled', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: true,
        }).reactNativeBundles?.featureEnabled).toBe(false);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: true,
            reactNativeBundlesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.reactNativeBundles',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        }).reactNativeBundles?.featureEnabled).toBe(true);
    });

    it('reports structured-message feature enablement from the canonical feature decision', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
        }).structuredMessages?.featureEnabled).toBe(false);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            structuredMessagesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.structuredMessages',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        }).structuredMessages?.featureEnabled).toBe(true);
    });

    it('does not enable hosted web without the canonical feature decision being enabled', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
        }).hostedWeb?.featureEnabled).toBe(false);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            hostedWebFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.hostedWeb',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        }).hostedWeb?.featureEnabled).toBe(true);
    });

    it('threads daemon-owned React Native crash-disabled contribution ids into the host runtime context', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            installedArtifactLoaderAvailable: true,
            reactNativeBundlesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.reactNativeBundles',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
            reactNativeCrashDisabledContributionIds: ['runtime.plugin:native-compatible'],
        }).reactNativeBundles).toMatchObject({
            crashDisabledContributionIds: ['runtime.plugin:native-compatible'],
            crashDisabledByContributionId: {
                'runtime.plugin:native-compatible': true,
            },
        });
    });
});
