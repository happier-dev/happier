import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { createTargetActionHostBindingResolver, createTargetActionHostPolicyResolver } from '@/plugins/runtime/hostAccess/resolve';
import { buildTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/buildTargetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { buildPluginProjectionV2 } from './v2';

/**
 * EU-5c / EU-5d gate — the semantic host-extension chain, end to end.
 *
 * The host-rendered `sessionHeaderActions` family is an ActionSpec *reference*:
 * they carry identity, label, applicability and a reference, and the referenced
 * `actions` contribution owns the runtime callback. This test walks one such
 * seam through every stage the gate names, using the real owner at each stage:
 *
 *   external manifest text
 *     -> `ingestCanonicalPluginManifest`      (canonical CLI normalization; the
 *                                              same call `readPluginManifest`
 *                                              makes for an installed plugin)
 *     -> `projectLoadedPluginContributes`     (candidate projection)
 *     -> `createResolvedContributionRegistry` (ONE registration transaction,
 *                                              qualified-key identity)
 *     -> `buildPluginProjectionV2`            (what the client receives)
 *     -> `activatePluginRuntimeRegistry`      (the referenced action's handler)
 *     -> `executePluginActionIfAvailable`     (invocation + current result)
 *     -> generation replacement + retirement
 *     -> uninstall cleanup
 *
 * Placement is the client's half of the same chain and is proven at its own
 * owner in `apps/ui` (`pluginHeaderActions.test.tsx`); the join between the
 * halves is the wire projection asserted here.
 */

const PLUGIN_ID = 'acme.preview';
const HEADER_ACTION_LOCAL_ID = 'open-preview';
const QUALIFIED_ACTION_ID = `${PLUGIN_ID}/${HEADER_ACTION_LOCAL_ID}`;

function externalManifestText(version: string): string {
    return JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version,
        displayName: 'Acme preview',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        contributes: {
            actions: [{
                id: HEADER_ACTION_LOCAL_ID,
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
            }],
            sessionHeaderActions: [{
                id: 'preview',
                title: 'Preview',
                command: HEADER_ACTION_LOCAL_ID,
                order: 10,
            }],
        },
    });
}

function ingest(manifestText: string) {
    const ingested = ingestCanonicalPluginManifest(manifestText, { sourceProvenance: 'registryCustodied' });
    if (!ingested.ok) {
        throw new Error(ingested.diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'));
    }
    return ingested.manifest;
}

function loadedPlugin(manifestText: string): LoadedPlugin {
    return {
        pluginId: PLUGIN_ID,
        pluginRootPath: '/plugins/acme-preview',
        manifestPath: '/plugins/acme-preview/.happier-plugin/plugin.json',
        daemonEntryPath: '/plugins/acme-preview/daemon.mjs',
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme-preview',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: ingest(manifestText),
    };
}

function resolveRegistry(loadedPlugins: readonly LoadedPlugin[]): ResolvedContributionRegistry {
    return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
        provenance: 'external',
    }));
}

let activationSourceSeq = 0;

async function activateWith(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    activate: (api: PluginApi) => void | (() => void);
}>) {
    // A distinct module id per activation. `loadPluginModule` caches the loaded
    // module NAMESPACE by module id, which is correct in production (a real
    // daemon module exports one stable `activate`, re-invoked per activation).
    // Here each activation supplies a different `activate` closure inside its
    // own namespace, so sharing one module id would silently re-run the first
    // closure.
    activationSourceSeq += 1;
    const moduleId = `@happier-dev/plugins-acme-preview/daemon#${activationSourceSeq}`;
    return activatePluginRuntimeRegistry({
        contributes: params.registry,
        generation: params.generation,
        resolveActivationSource: () => ({
            kind: 'bundled',
            moduleId,
            load: async () => ({ activate: params.activate }),
        }),
    });
}

function executableRegistry(params: Readonly<{
    registry: ResolvedContributionRegistry;
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>;
    /**
     * Defaults to the activation's own registrations. A different activation's
     * registrations is exactly the superseded-publication case.
     */
    targetRegistrations?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['targetRegistrations'];
}>): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: params.registry,
        generation: params.activated.generation,
        targetActivationFacts: params.activated.targetActivationFacts,
        hookHandlersByHookId: params.activated.hookHandlersByHookId,
        agentRuntimesByAgentId: params.activated.agentRuntimesByAgentId,
        scmHostingProvidersById: params.activated.scmHostingProvidersById,
        activateContributionsOnDemand: params.activated.activateContributionsOnDemand,
        targetActionInvocations: buildTargetActionInvocationRegistry({
            contributes: params.registry,
            targetRegistrations: params.targetRegistrations ?? params.activated.targetRegistrations,
            targetActivationFacts: params.activated.targetActivationFacts,
            resolveAuthorizationFacts: (action) => ({
                generation: {
                    targetGeneration: action.generation,
                    desiredGeneration: action.generation,
                    appliedGeneration: action.generation,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            resolveHostBinding: createTargetActionHostBindingResolver(),
            resolveHostPolicy: createTargetActionHostPolicyResolver(),
            createServices: createUnavailablePluginServicesFactory(),
        }),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

async function invokePreview(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    context: Readonly<{ sessionId?: string }> = { sessionId: 'session-1' },
) {
    return executePluginActionIfAvailable({
        runtimeRegistry: registry,
        actionId: QUALIFIED_ACTION_ID,
        input: { messageId: 'msg-1' },
        context: {
            surface: 'ui',
            ...(context.sessionId ? { defaultSessionId: context.sessionId } : {}),
        },
    });
}

describe('EU-5c/EU-5d semantic host-extension chain', () => {
    it('carries one external declaration from manifest text to invocation, replacement and uninstall', async () => {
        // 1. External manifest -> canonical normalization.
        const plugin = loadedPlugin(externalManifestText('1.0.0'));

        // 2. Candidate projection -> ONE registration transaction.
        const registry = resolveRegistry([plugin]);
        expect(registry.actionsById?.get(QUALIFIED_ACTION_ID)).toEqual(expect.objectContaining({
            pluginId: PLUGIN_ID,
            definition: expect.objectContaining({ id: HEADER_ACTION_LOCAL_ID }),
        }));
        // The transaction keys by the QUALIFIED identity, never the local id —
        // a local-id key is the defect that made `runProjectedPluginAction` a
        // silent no-op before EU-5c deleted it.
        expect(registry.actionsById?.get(HEADER_ACTION_LOCAL_ID)).toBeUndefined();

        // 3. Projection — exactly the facts the client placement owner requires.
        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
        });
        const uiEntries = projection.familiesById.pluginUi?.entriesById ?? {};
        // The author declares the bare local id; the compiled projection carries
        // the qualified semantic action, which is the only shape a client reader
        // accepts (no consumer requalifies a local id).
        expect(uiEntries[`sessionHeaderAction:${PLUGIN_ID}:preview`]).toEqual(expect.objectContaining({
            pluginId: PLUGIN_ID,
            contributionKind: 'sessionHeaderAction',
            descriptorId: 'preview',
            command: {
                kind: 'executeAction',
                action: { pluginId: PLUGIN_ID, localId: HEADER_ACTION_LOCAL_ID },
            },
            order: 10,
        }));
        // The client resolves the header action against `actionsById` and drops
        // it unless the target is UI-surfaced and available.
        expect(projection.actionsById[QUALIFIED_ACTION_ID]).toEqual(expect.objectContaining({
            pluginId: PLUGIN_ID,
            id: HEADER_ACTION_LOCAL_ID,
            surfaces: expect.arrayContaining(['ui']),
        }));

        // 4. Activation of the referenced action + invocation.
        const firstHandler = vi.fn(async () => ({ ok: true, generation: 1 }));
        const firstCleanup = vi.fn();
        const firstActivated = await activateWith({
            registry,
            generation: 1,
            activate: (api) => {
                api.actions.register(HEADER_ACTION_LOCAL_ID, firstHandler);
                return firstCleanup;
            },
        });
        try {
            const firstAttempt = await invokePreview(executableRegistry({
                registry,
                activated: firstActivated,
            }));
            expect(firstAttempt).toEqual({
                matched: true,
                result: { ok: true, result: { ok: true, generation: 1 } },
            });
            expect(firstHandler).toHaveBeenCalledTimes(1);

            // The declared `session` scope is enforced at invocation, not at
            // placement: the same seam without a session is refused.
            expect(await invokePreview(
                executableRegistry({ registry, activated: firstActivated }),
                {},
            )).toEqual({
                matched: true,
                result: expect.objectContaining({ ok: false, errorCode: 'plugin_action_session_required' }),
            });
            expect(firstHandler).toHaveBeenCalledTimes(1);

            // 5. Generation replacement — a new declaration and a new callback.
            const secondPlugin = loadedPlugin(externalManifestText('2.0.0'));
            const secondRegistry = resolveRegistry([secondPlugin]);
            const secondHandler = vi.fn(async () => ({ ok: true, generation: 2 }));
            const secondActivated = await activateWith({
                registry: secondRegistry,
                generation: 2,
                activate: (api) => {
                    api.actions.register(HEADER_ACTION_LOCAL_ID, secondHandler);
                },
            });
            try {
                const secondAttempt = await invokePreview(executableRegistry({
                    registry: secondRegistry,
                    activated: secondActivated,
                }));
                expect(secondAttempt).toEqual({
                    matched: true,
                    result: { ok: true, result: { ok: true, generation: 2 } },
                });
                // The superseded callback is not consulted by the new generation.
                expect(firstHandler).toHaveBeenCalledTimes(1);
                expect(secondHandler).toHaveBeenCalledTimes(1);
            } finally {
                await secondActivated.dispose();
            }
        } finally {
            // 6. Retirement — disposing the superseded generation runs the
            // plugin's own cleanup.
            await firstActivated.dispose();
        }
        expect(firstCleanup).toHaveBeenCalledTimes(1);

        // 7. Uninstall cleanup — the same owners, with the plugin gone.
        const uninstalledRegistry = resolveRegistry([]);
        const uninstalledProjection = buildPluginProjectionV2({
            registry: uninstalledRegistry,
            generation: 3,
        });
        expect(uninstalledProjection.familiesById.pluginUi?.entriesById[`sessionHeaderAction:${PLUGIN_ID}:preview`])
            .toBeUndefined();
        expect(uninstalledProjection.actionsById[QUALIFIED_ACTION_ID]).toBeUndefined();
        expect(await executePluginActionIfAvailable({
            registry: uninstalledRegistry,
            actionId: QUALIFIED_ACTION_ID,
            input: {},
            context: { surface: 'ui' },
        })).toEqual({ matched: false });
    });

    it('refuses a declaration that activation never backed, an undeclared registration and a stale generation', async () => {
        const registry = resolveRegistry([loadedPlugin(externalManifestText('1.0.0'))]);

        // Declared at manifest, never registered at activation: the seam is
        // reported as unbound rather than silently succeeding or silently
        // disappearing from the placement.
        const silent = await activateWith({ registry, generation: 1, activate: () => {} });
        try {
            expect(await invokePreview(executableRegistry({
                registry,
                activated: silent,
            }))).toEqual({
                matched: true,
                result: expect.objectContaining({
                    ok: false,
                    errorCode: 'plugin_activation_failed',
                    error: expect.stringContaining(`missing registration 'actions/${HEADER_ACTION_LOCAL_ID}'`),
                }),
            });
        } finally {
            await silent.dispose();
        }

        // Registered under an id the manifest never declared.
        const undeclared = await activateWith({
            registry,
            generation: 1,
            activate: (api) => {
                api.actions.register(HEADER_ACTION_LOCAL_ID, async () => ({ ok: true }));
                api.actions.register('smuggled', async () => ({ ok: true }));
            },
        });
        try {
            expect(undeclared.pluginDiagnosticsByPluginId[PLUGIN_ID]).toEqual([
                expect.objectContaining({
                    code: 'plugin_activation_failed',
                    message: expect.stringContaining('smuggled'),
                }),
            ]);
            expect(undeclared.failedActivationPluginIds.has(PLUGIN_ID)).toBe(true);
        } finally {
            await undeclared.dispose();
        }

        // Published for a generation that is no longer the current one: the
        // superseded activation's registrations against the current
        // activation's facts. Nothing here is synthetic — both halves come from
        // a real `activatePluginRuntimeRegistry` run.
        const superseded = await activateWith({
            registry,
            generation: 1,
            activate: (api) => {
                api.actions.register(HEADER_ACTION_LOCAL_ID, async () => ({ ok: true }));
            },
        });
        const current = await activateWith({
            registry,
            generation: 2,
            activate: (api) => {
                api.actions.register(HEADER_ACTION_LOCAL_ID, async () => ({ ok: true }));
            },
        });
        try {
            expect(() => executableRegistry({
                registry,
                activated: current,
                targetRegistrations: superseded.targetRegistrations,
            })).toThrowError(/is not backed by an active generation fact/);
            // The same call with the matching registrations is admitted, so the
            // refusal above is the generation mismatch and nothing else.
            expect(() => executableRegistry({ registry, activated: current })).not.toThrow();
        } finally {
            await current.dispose();
            await superseded.dispose();
        }
    });

    it('refuses a header action whose reference does not resolve', () => {
        const dangling = ingestCanonicalPluginManifest(externalManifestText('1.0.0')
            .replace(`"action":"${HEADER_ACTION_LOCAL_ID}"`, '"action":"not-declared"'), { sourceProvenance: 'registryCustodied' });
        expect(dangling.ok).toBe(false);
        expect(dangling.ok === false && dangling.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_manifest_dangling_reference' }),
        ]));
    });
});
