import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { verifyPluginUiArtifactBytesIntegrityV1 } from '@happier-dev/protocol/plugins/ui';

import { resolveContainedPluginResourcePath } from '../resources/package/resolve';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import { buildPluginProjectionV2 } from './projection/v2';
import {
    BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
    BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
} from './sources/generatedBundledPlugins';
import { FIRST_PARTY_UI_ARTIFACTS, FIRST_PARTY_UI_HOST_APP_VERSION } from './firstPartyUiContributions';
import type { ResolvedContributionInputs } from './types';

const INSPECTOR_PLUGIN_ID = 'happier.inspector';
const LEGACY_INSPECTOR_OWNER_PLUGIN_ID = 'happier.core';

function projectBuiltInProjection(
    connectingPlatform?: string,
    hostRuntimeOverride: Readonly<{
        channel?: string;
        hostAppVersion?: string;
    }> = {},
) {
    const registry = createResolvedContributionRegistry(resolveUiOnlyBuiltInContributions());
    return buildPluginProjectionV2({
        registry,
        generation: 1,
        // Structured messages are gated behind the `plugins.ui.structuredMessages`
        // server bit; surface it enabled so the message surface projects (the other
        // host surfaces are gated only by the `plugins.ui` placement mount, which
        // is unconditional for `{kind:'host'}` renderers). The top-tier
        // `plugins.ui.reactNativeBundles` gate is server-represented and
        // already default-enabled in production (RN-SCAFFOLD item 4); this
        // synthetic test projection has no server payload to read that default
        // from, so it is set explicitly here — same reason the equivalent
        // hostedWeb test below used to set `hostedWeb.featureEnabled`.
        pluginUiHostRuntime: {
            structuredMessages: { featureEnabled: true },
            reactNativeBundles: {
                featureEnabled: true,
                loaderBackendAvailable: true,
                ...(connectingPlatform
                    ? {
                        hostRuntime: {
                            platform: connectingPlatform,
                            channel: hostRuntimeOverride.channel ?? 'internal',
                            hostAppVersion: hostRuntimeOverride.hostAppVersion ?? FIRST_PARTY_UI_HOST_APP_VERSION,
                            hostUiApiVersion: '1.0.0',
                            reactVersion: '19.2.0',
                            reactNativeVersion: '0.83.4',
                            availableNativeCapabilities: [],
                        },
                    }
                    : {}),
            },
        },
    });
}

function resolveUiOnlyBuiltInContributions(): ResolvedContributionInputs {
    const builtIn = resolveBuiltInContributions();
    return {
        agents: [],
        agentRuntimes: [],
        catalogEntries: [],
        actions: [],
        executionRunProfiles: [],
        managedDependencies: [],
        activationTargets: [],
        scmHostingProviders: [],
        scmBackends: [],
        connectedAccountDescriptors: [],
        hookRegistrations: [],
        pluginDiagnosticsByPluginId: {},
        uiTranslations: builtIn.uiTranslations,
        surfacePlacements: builtIn.surfacePlacements,
        structuredMessages: builtIn.structuredMessages,
        reactNativeBundles: builtIn.reactNativeBundles,
        uiArtifacts: builtIn.uiArtifacts,
        settings: builtIn.settings,
    };
}

function projectBuiltInPluginUi() {
    return projectBuiltInProjection().familiesById.pluginUi?.entriesById ?? {};
}

describe('first-party inspector plugin UI contributions (UI-DOGFOOD, RN-DOGFOOD)', () => {
    it('projects exactly one inspector UI owner (reactNative surface) and retires the legacy happier.core owner', () => {
        const entries = projectBuiltInPluginUi();
        const legacyInspectorKeys = Object.keys(entries).filter((key) =>
            key.includes(`${LEGACY_INSPECTOR_OWNER_PLUGIN_ID}:inspector`)
        );

        expect(legacyInspectorKeys).toEqual([]);
        const inspectorEntry = entries[`surfacePlacement:${INSPECTOR_PLUGIN_ID}:inspector-app`];
        expect(inspectorEntry).toMatchObject({
            contributionKind: 'surfacePlacement',
            pluginId: INSPECTOR_PLUGIN_ID,
            placement: 'app.rightSidebarTab',
            renderer: {
                kind: 'reactNative',
                contributionId: 'inspector-app-native',
            },
            rightSidebar: { tabId: 'plugin-inspector', scope: 'app' },
        });
        // NATIVE-PIPELINE: two sibling reactNativeBundles contributions now
        // exist for `inspector-app-native` (web dev-hot-reload + real ios
        // artifact) and this synthetic host-runtime context reports no
        // connecting platform identity — the placement correctly reports
        // `fallback`/`platform_unavailable` (graceful unavailable, not a
        // guess). See `ui/projection.test.ts`'s "platform-family resolution"
        // suite for the full web/ios/missing-platform matrix, and the
        // `hostRuntime`-scoped tests below for both platforms resolving.
        expect(inspectorEntry).toMatchObject({
            availability: {
                state: 'fallback',
                reason: 'platform_unavailable',
            },
        });
        // RN-DOGFOOD: hostedWeb is retired for the inspector — no hostedWeb
        // projection entry should exist for it (one UI owner, no dual UI).
        expect(Object.keys(entries).some((key) => key.startsWith(`hostedWeb:${INSPECTOR_PLUGIN_ID}:`))).toBe(false);
    });

    // NATIVE-PIPELINE: a connecting ios client resolves the real, first-ever
    // Re.Pack-built artifact through the SAME first-party bundled-plugin
    // registration path (`firstPartyUiContributions.ts`'s
    // `FIRST_PARTY_UI_ARTIFACTS`) — proving item 3 (manifest entries + this
    // registration path + pack pipeline) end-to-end, not just item 1's
    // selection logic in isolation.
    it('resolves the inspector reactNativeBundle to the real ios artifact for a connecting ios client', () => {
        const entries = projectBuiltInProjection('ios').familiesById.pluginUi?.entriesById ?? {};
        const entry = entries[`reactNativeBundle:${INSPECTOR_PLUGIN_ID}:inspector-app-native`];

        expect(entry).toMatchObject({
            bundle: { platform: 'ios' },
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    it('loads the inspector ios artifact for a development dev-build client reporting the real app version', () => {
        const entries = projectBuiltInProjection('ios', {
            channel: 'development',
            hostAppVersion: FIRST_PARTY_UI_HOST_APP_VERSION,
        }).familiesById.pluginUi?.entriesById ?? {};
        const entry = entries[`reactNativeBundle:${INSPECTOR_PLUGIN_ID}:inspector-app-native`];

        expect(entry).toMatchObject({
            bundle: { platform: 'ios' },
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    // FIX-RNWEB-SERVING: a connecting web client now resolves the SAME
    // `installedArtifact` production-serving story as ios — a real,
    // digest-verified web artifact (Vite + react-native-web build of the
    // SAME `renderSurface.tsx` source), registered through the SAME
    // `FIRST_PARTY_UI_ARTIFACTS` path. This closes LIVE-MATRIX's Cell-1
    // structural finding: the web sibling used to have no `uiArtifact`
    // registered anywhere and could never become loadable, independent of
    // any feature gate.
    it('resolves the inspector reactNativeBundle to the real web artifact for a connecting web client', () => {
        const entries = projectBuiltInProjection('web').familiesById.pluginUi?.entriesById ?? {};
        const entry = entries[`reactNativeBundle:${INSPECTOR_PLUGIN_ID}:inspector-app-native`];

        expect(entry).toMatchObject({
            bundle: { platform: 'web' },
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    it('projects inspector settings as plugin-local settings, not UI descriptors', () => {
        const projection = projectBuiltInProjection();

        expect(projection.settingsById['happier.inspector.settings']).toMatchObject({
            id: 'happier.inspector.settings',
            pluginId: INSPECTOR_PLUGIN_ID,
            storageScope: 'pluginLocal',
            fields: [
                expect.objectContaining({
                    id: 'happier.inspector.showDiagnostics',
                    control: 'switch',
                    defaultBooleanValue: true,
                }),
            ],
        });
        expect(projection.uiDescriptorsById['happier.inspector.settings']).toBeUndefined();
    });

    it('includes the inspector plugin in bundled first-party activation targets', () => {
        expect(BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES).toContain('@happier-dev/plugins-inspector');
        expect(BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: INSPECTOR_PLUGIN_ID,
                source: { kind: 'bundled' },
                daemonEntryPath: '@happier-dev/plugins-inspector',
                sourceSpec: expect.objectContaining({
                    kind: 'bundled',
                    locator: '@happier-dev/plugins-inspector',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                }),
            }),
        ]));
    });

    it('resolves the bundled inspector reactNativeBundles contributions into the registry by contribution id + platform', () => {
        const registry = createResolvedContributionRegistry(resolveUiOnlyBuiltInContributions());
        const webResolved = registry.reactNativeBundlesById?.get(`${INSPECTOR_PLUGIN_ID}:inspector-app-native:web`);
        const iosResolved = registry.reactNativeBundlesById?.get(`${INSPECTOR_PLUGIN_ID}:inspector-app-native:ios`);

        // FIX-RNWEB-SERVING: the web sibling is now a real production
        // artifact declaration, mirroring ios (see manifest.ts's module doc
        // for why dev-hot-reload is not the right story for a first-party
        // bundled plugin).
        expect(webResolved).toMatchObject({
            pluginId: INSPECTOR_PLUGIN_ID,
            definition: expect.objectContaining({
                id: 'inspector-app-native',
                bundle: expect.objectContaining({
                    platform: 'web',
                    channel: 'internal',
                    assetPath: 'react-native-web/inspector-app-native/entry.mjs',
                }),
                entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
            }),
        });
        // NATIVE-PIPELINE: the second, real ios sibling.
        expect(iosResolved).toMatchObject({
            pluginId: INSPECTOR_PLUGIN_ID,
            definition: expect.objectContaining({
                id: 'inspector-app-native',
                bundle: expect.objectContaining({ platform: 'ios', channel: 'internal' }),
                entry: expect.objectContaining({ modulePath: './renderSurface', exportName: 'renderSurface' }),
            }),
        });
    });

    // FIX-RNWEB-SERVING: end-to-end proof that the SAME real
    // `DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ` codepath this registration feeds
    // (`resolveContainedPluginResourcePath` + `readFile` +
    // `verifyPluginUiArtifactBytesIntegrityV1`, exactly as
    // `daemonContributionRegistryProjection.ts` calls them) can ACTUALLY read
    // and integrity-verify the real bytes on disk for BOTH platform
    // artifacts — not just that the registration objects are shaped
    // correctly. This is the exact real-file resolution this lane found
    // broken twice: (1) `assetPath` was relative to
    // `dist/happier-plugin-ui/`, not the plugin package root
    // (`INSPECTOR_UI_ARTIFACTS_ROOT_PATH` fixes this for both siblings), and
    // (2) the ios digest NATIVE-PIPELINE recorded did not match the real
    // file's single-file sha256 (the ONLY digest scheme the byte-serving
    // path ever verifies against — confirmed by reading
    // `daemonContributionRegistryProjection.ts`'s own
    // `verifyPluginUiArtifactBytesIntegrityV1` call site).
    it.each(FIRST_PARTY_UI_ARTIFACTS.map((artifact) => [artifact.definition.platform, artifact] as const))(
        'reads and integrity-verifies the real on-disk %s artifact through the real byte-serving resolution path',
        async (_platform, artifact) => {
            const pluginRootPath = artifact.pluginRootPath;
            const assetPath = artifact.definition.assetPath;
            expect(pluginRootPath).toBeTruthy();
            expect(assetPath).toBeTruthy();

            const resolved = await resolveContainedPluginResourcePath({
                pluginRootPath: pluginRootPath!,
                resourcePath: assetPath!,
            });
            expect(resolved).not.toBeNull();

            const bytes = await readFile(resolved!.absolutePath);
            expect(bytes.byteLength).toBe(artifact.definition.byteSize);

            const integrity = verifyPluginUiArtifactBytesIntegrityV1({
                bytes,
                integrity: {
                    digest: artifact.definition.integrity!.digest,
                    pluginId: artifact.pluginId!,
                    contributionId: artifact.definition.contributionId,
                    artifactKind: artifact.definition.artifactKind,
                },
            });
            expect(integrity.ok).toBe(true);
        },
    );
});
