import { describe, expect, it, vi } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { buildTargetActionInvocationRegistry } from './buildTargetActionRegistry';
import {
    createTargetActionHostBindingResolver,
    createTargetActionHostPolicyResolver,
} from '../hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from './services/factory';
import type { TargetActionAuthorizationFacts } from '../policy/evaluate';

type BuildRegistryParams = Omit<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveAuthorizationFacts' | 'resolveHostBinding' | 'resolveHostPolicy'
> & Partial<Pick<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveHostBinding' | 'resolveHostPolicy'
>> & Readonly<{
    resolveAuthorizationFacts?: (action: Readonly<{
        pluginId: string;
        generation: string;
        qualifiedId: string;
    }>) => TargetActionAuthorizationFacts;
}>;

function buildRegistry(
    params: BuildRegistryParams,
) {
    return buildTargetActionInvocationRegistry({
        createServices: createUnavailablePluginServicesFactory(),
        resolveAuthorizationFacts: () => authorizationFacts(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        resolveHostPolicy: createTargetActionHostPolicyResolver(),
        ...params,
    });
}

const handler = async () => ({ ok: true });

function manifest(params: Readonly<{
    hostAccess?: Readonly<Record<string, unknown>>;
    actionHostAccess?: readonly string[];
    dangerLevel?: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive';
    inputSchema?: Readonly<Record<string, unknown>>;
    resultSchema?: Readonly<Record<string, unknown>>;
    availability?: Readonly<Record<string, unknown>>;
}> = {}) {
    const value = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: 'acme.alpha',
        version: '1.2.3',
        hostAccess: params.hostAccess ?? { required: [], optional: [] },
        contributes: {
            actions: [{
                id: 'run', title: 'Run', description: 'Run', scopes: ['global'], surfaces: ['cli'],
                placement: 'commandPalette', dangerLevel: params.dangerLevel ?? 'safe',
                ...(params.dangerLevel && params.dangerLevel !== 'safe'
                    ? {
                        confirmation: {
                            title: 'Confirm run',
                            body: { key: 'actions.run.confirmationBody', fallback: 'This action changes external state.' },
                            confirmLabel: 'Run action',
                        },
                    }
                    : {}),
                ...(params.actionHostAccess ? { hostAccess: params.actionHostAccess } : {}),
                ...(params.inputSchema ? { inputSchema: params.inputSchema } : {}),
                ...(params.resultSchema ? { resultSchema: params.resultSchema } : {}),
                ...(params.availability ? { availability: params.availability } : {}),
            }],
        },
    }));
    if (!value) throw new Error('canonical action manifest fixture is invalid');
    return value;
}

function activationTarget(
    pluginManifest = manifest(),
    trustPolicy: 'local_trusted' | 'prompt' | 'untrusted' = 'local_trusted',
) {
    return {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'acme.alpha',
        manifestPath: '/tmp/plugin.json',
        manifestDigest: 'digest',
        daemonEntryPath: '/tmp/plugin.js',
        sourceSpec: { kind: 'path' as const, locator: '/tmp', trustPolicy, installPolicy: 'link' as const },
        manifest: pluginManifest,
    };
}

function registry(params: Readonly<{
    pluginManifest?: ReturnType<typeof manifest>;
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
}> = {}) {
    const pluginManifest = params.pluginManifest ?? manifest();
    return {
        actions: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.alpha',
            definition: {
                kindVersion: 1, id: 'run', title: 'Run', description: null, safety: 'safe',
                dangerLevel: 'safe',
                placements: [], slash: null, bindings: null, examples: null,
                surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, sdk: false },
                inputHints: null, inputSchema: {},
            },
        }],
        activationTargets: [activationTarget(pluginManifest, params.trustPolicy)],
    } as unknown as ResolvedContributionRegistry;
}

function authorizationFacts(overrides: Readonly<{
    packageIdentity?: string;
    reviewedPackageIdentity?: string | null;
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    resourceSelections?: TargetActionAuthorizationFacts['resourceSelections'];
}> = {}): TargetActionAuthorizationFacts {
    return Object.freeze({
        packageTrust: Object.freeze({
            packageIdentity: overrides.packageIdentity ?? 'package:acme.alpha:generation-7',
            reviewedPackageIdentity: overrides.reviewedPackageIdentity === undefined
                ? 'package:acme.alpha:generation-7'
                : overrides.reviewedPackageIdentity,
        }),
        generation: Object.freeze({
            targetGeneration: '7',
            desiredGeneration: overrides.desiredGeneration === undefined ? '7' : overrides.desiredGeneration,
            appliedGeneration: overrides.appliedGeneration === undefined ? '7' : overrides.appliedGeneration,
        }),
        resourceSelections: overrides.resourceSelections ?? Object.freeze([]),
        scopedGrants: Object.freeze([]),
        operatingSystemAuthorization: Object.freeze([]),
    });
}

function registryWithHostAccess() {
    const base = registry();
    const pluginManifest = manifest({
        hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } }], optional: [] },
        actionHostAccess: ['api'],
    });
    return {
        actions: [base.actions[0]!],
        activationTargets: [activationTarget(pluginManifest)],
    } as unknown as ResolvedContributionRegistry;
}

function fact(overrides: Partial<PluginTargetActivationFact> = {}): PluginTargetActivationFact {
    return {
        pluginId: 'acme.alpha', pluginVersion: '1.2.3', source: 'localPath', generation: '7',
        host: 'daemon', platform: 'darwin', occurredAtMs: 1, status: 'active',
        required: [{ family: 'actions', localId: 'run' }],
        bound: [{ family: 'actions', localId: 'run' }], diagnostics: [], ...overrides,
    };
}

describe('buildTargetActionInvocationRegistry', () => {
    it('enforces the canonical manifest resultSchema at the production registry builder', async () => {
        const pluginManifest = manifest({
            resultSchema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
            },
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: async () => ({ wrong: true }),
                },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'invalid',
            code: 'plugin_action_result_schema_invalid',
        });
    });

    it('uses committed package authorization instead of the discovery source trust string', async () => {
        const committedHandler = vi.fn(handler);
        const committed = buildRegistry({
            contributes: registry({ trustPolicy: 'prompt' }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: committedHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts(),
        });
        await expect(committed.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({ status: 'executed' });
        expect(committedHandler).toHaveBeenCalledOnce();

        const uncommittedHandler = vi.fn(handler);
        const uncommitted = buildRegistry({
            contributes: registry({ trustPolicy: 'local_trusted' }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: uncommittedHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts({ reviewedPackageIdentity: null }),
        });
        await expect(uncommitted.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable', code: 'plugin_action_package_untrusted',
        });
        expect(uncommittedHandler).not.toHaveBeenCalled();
    });

    it.each([
        'writesLocal',
        'writesRemote',
        'externalSideEffect',
        'destructive',
    ] as const)('requires current intent before invoking a %s action', async (dangerLevel) => {
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ dangerLevel }) }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable', code: 'plugin_action_current_intent_unavailable',
        });
        expect(actionHandler).not.toHaveBeenCalled();

        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({
            status: 'approved' as const,
            fingerprint,
        }));
        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'visible', requiresCurrentIntent: true,
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli', requestCurrentIntent,
        })).resolves.toMatchObject({ status: 'executed' });
        expect(requestCurrentIntent).toHaveBeenCalledOnce();
        expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({
                confirmation: {
                    title: 'Confirm run',
                    body: { key: 'actions.run.confirmationBody', fallback: 'This action changes external state.' },
                    confirmLabel: 'Run action',
                },
            }),
        }));
        expect(actionHandler).toHaveBeenCalledOnce();
    });

    it.each([
        ['desired generation', { desiredGeneration: '8' }],
        ['applied generation', { appliedGeneration: '8' }],
        ['package identity', { packageIdentity: 'package:acme.alpha:generation-8' }],
    ] as const)('rechecks %s after present intent before calling the handler', async (_label, changedFacts) => {
        let facts = authorizationFacts();
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ dangerLevel: 'writesRemote' }) }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => facts,
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
            requestCurrentIntent: async ({ fingerprint }) => {
                facts = authorizationFacts(changedFacts);
                return { status: 'approved', fingerprint };
            },
        })).resolves.toMatchObject({ status: 'unavailable' });
        expect(actionHandler).not.toHaveBeenCalled();
    });

    it.each([
        ['exact selection', 'selected', 'executed'],
        ['absent selection', 'absent', 'unavailable'],
        ['broader request', 'broader', 'unavailable'],
    ] as const)('enforces the %s from persisted host-resource authorization facts', async (_label, selection, status) => {
        const actionHandler = vi.fn(handler);
        const requestedResourceId = 'mcp:acme.tools/runtime:listTools';
        const target = buildRegistry({
            contributes: registry(),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts({
                resourceSelections: [Object.freeze({
                    id: 'selected-mcp',
                    required: true,
                    requestedResourceId,
                    ...(selection === 'selected'
                        ? { selectedResourceId: requestedResourceId }
                        : selection === 'broader'
                            ? { selectedResourceId: `${requestedResourceId}:discover` }
                            : {}),
                })],
            }),
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({ status });
        expect(actionHandler).toHaveBeenCalledTimes(status === 'executed' ? 1 : 0);
    });

    it('rejects missing, extra, and wrong-generation action publications', () => {
        expect(() => buildRegistry({
            contributes: registry(), generation: 7, targetRegistrations: [], targetActivationFacts: [fact()],
        })).toThrow(/no committed registration/i);

        expect(() => buildRegistry({
            contributes: registry(), generation: 7,
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '8', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        })).toThrow(/wrong generation/i);

        expect(() => buildRegistry({
            contributes: registry(), generation: 7,
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '7', registration: { family: 'actions', localId: 'extra', value: handler } }],
            targetActivationFacts: [fact({ required: [], bound: [{ family: 'actions', localId: 'extra' }] })],
        })).toThrow(/no matching manifest action/i);
    });

    it('uses host-owned activation metadata and exact qualified identity', async () => {
        let contextVersion: string | undefined;
        const target = buildRegistry({
            contributes: registry(), generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: async (_input, context) => {
                    contextVersion = context.plugin.version;
                    return { ok: true };
                } },
            }],
            targetActivationFacts: [fact()],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toEqual({ status: 'executed', value: { ok: true } });
        expect(contextVersion).toBe('1.2.3');
    });

    it('rebuilds from the complete live generation publication after lazy activation', async () => {
        const targetRegistrations: Array<{
            pluginId: string;
            generation: string;
            registration: { family: 'actions'; localId: string; value: typeof handler };
        }> = [];
        const targetActivationFacts: PluginTargetActivationFact[] = [];
        const target = buildRegistry({
            contributes: registry(), generation: 7, targetRegistrations, targetActivationFacts,
        });
        expect(target.has('acme.alpha', 'run')).toBe(false);

        targetRegistrations.push({
            pluginId: 'acme.alpha', generation: '7',
            registration: { family: 'actions', localId: 'run', value: handler },
        });
        targetActivationFacts.push(fact());
        target.refresh();

        expect(target.has('acme.alpha', 'run')).toBe(true);
        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
    });

    it('passes the exact structured manifest request to the host-access owner', async () => {
        const unavailableResolver = createTargetActionHostBindingResolver();
        const resolveHostBinding = vi.fn(unavailableResolver);
        const target = buildRegistry({
            contributes: registryWithHostAccess(), generation: 7,
            resolveHostBinding,
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '7', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_host_access_service_unavailable' });
        expect(resolveHostBinding).toHaveBeenCalledWith(
            expect.objectContaining({ pluginId: 'acme.alpha' }),
            expect.objectContaining({
                hostAccessRequests: [expect.objectContaining({
                    required: true,
                    request: expect.objectContaining({ capability: 'network', scope: expect.objectContaining({ methods: ['GET'] }) }),
                })],
            }),
        );
    });

    it('keeps catalog authorization aligned with unavailable declared host access', async () => {
        const target = buildRegistry({
            contributes: registryWithHostAccess(),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
        });

        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        });
    });

    it('keeps catalog authorization aligned with declaration availability', async () => {
        const pluginManifest = manifest({
            availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            },
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            generation: 7,
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
        });

        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'unavailable',
            code: 'plugin_contribution_not_applicable',
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_contribution_not_applicable',
        });
    });
});
