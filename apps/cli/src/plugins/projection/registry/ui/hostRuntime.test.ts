import { describe, expect, it } from 'vitest';
import { createFeatureDecision } from '@happier-dev/protocol';

import {
    resolvePluginUiProjectionHostRuntime,
    resolveReactNativeRepackLoaderBackendAvailability,
} from './hostRuntime';

describe('plugin UI projection host runtime', () => {
    it('keeps Re.Pack loader readiness false when the client runtime package is absent', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            isRepackClientPackageResolvable: () => false,
            installedArtifactLoaderAvailable: true,
        })).toEqual({
            available: false,
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_package_missing',
            ],
            unavailableReason: '@callstack/repack/client is not installed in this checkout',
        });
    });

    it('does not report loader readiness from Re.Pack package presence alone', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            isRepackClientPackageResolvable: () => true,
            installedArtifactLoaderAvailable: false,
        })).toEqual({
            available: false,
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_installed_artifact_loader_unavailable',
            ],
            unavailableReason: 'Re.Pack ScriptManager is installed, but the host installed-artifact module loader is not wired',
        });
    });

    it('does not report loader readiness until the native ScriptManager runtime is explicitly integrated', () => {
        expect(resolveReactNativeRepackLoaderBackendAvailability({
            isRepackClientPackageResolvable: () => true,
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
            isRepackClientPackageResolvable: () => true,
            installedArtifactLoaderAvailable: true,
            scriptManagerRuntimeIntegrated: true,
            reactNativeHostRuntime: {
                platform: 'ios',
                channel: 'internal',
            },
        }).reactNativeBundles?.loaderBackendAvailable).toBe(true);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            isRepackClientPackageResolvable: () => true,
            installedArtifactLoaderAvailable: false,
        }).reactNativeBundles?.loaderBackendAvailable).toBe(false);
    });

    it('does not report loader readiness until the active native runtime identity is known', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            isRepackClientPackageResolvable: () => true,
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

    it('does not enable React Native bundles without the canonical feature decision being enabled', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            isRepackClientPackageResolvable: () => true,
            installedArtifactLoaderAvailable: true,
        }).reactNativeBundles?.featureEnabled).toBe(false);

        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            isRepackClientPackageResolvable: () => true,
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

    it('does not enable embedded web bundles without the canonical feature decision being enabled', () => {
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
        }).embeddedWebBundles?.featureEnabled).toBe(false);
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
        }).embeddedWebBundles?.csp).toEqual({
            supportsSameOriginModuleUrl: false,
            allowsBlobModuleImport: false,
        });
        expect(resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
        }).embeddedWebBundles?.loaderBackendAvailable).toBe(false);
    });

    it('does not synthesize the embedded-web CSP capability from the feature flag', () => {
        // Even with the family feature enabled, with no real deployment-CSP
        // signal the CSP capability must default fail-closed (NOT
        // allowsBlobModuleImport:true) — the old fail-open shortcut is removed.
        const enabledNoProbe = resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            embeddedWebBundlesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.embeddedWebBundles',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        });
        expect(enabledNoProbe.embeddedWebBundles).toMatchObject({
            featureEnabled: true,
            loaderBackendAvailable: true,
            csp: {
                supportsSameOriginModuleUrl: false,
                allowsBlobModuleImport: false,
            },
        });
    });

    it('derives the embedded-web CSP capability from the deployment probe signal', () => {
        const probed = resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            embeddedWebBundlesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.embeddedWebBundles',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
            deploymentCspCapability: {
                supportsSameOriginModuleUrl: true,
                allowsBlobModuleImport: true,
            },
        });
        expect(probed.embeddedWebBundles?.csp).toEqual({
            supportsSameOriginModuleUrl: true,
            allowsBlobModuleImport: true,
        });

        // A strict deployment that forbids blob keeps the bit fail-closed even
        // though the same-origin bit is allowed.
        const strict = resolvePluginUiProjectionHostRuntime({
            hostAppVersion: '2.0.0',
            embeddedWebBundlesFeatureDecision: createFeatureDecision({
                featureId: 'plugins.ui.embeddedWebBundles',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
            deploymentCspCapability: {
                supportsSameOriginModuleUrl: true,
                allowsBlobModuleImport: false,
            },
        });
        expect(strict.embeddedWebBundles?.csp).toEqual({
            supportsSameOriginModuleUrl: true,
            allowsBlobModuleImport: false,
        });
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
            isRepackClientPackageResolvable: () => true,
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
