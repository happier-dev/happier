import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import {
    createSelectedPluginOptionalAccess,
} from '@/plugins/daemon/optionalAccessSelections';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import {
    PluginStateRecordSchema,
} from '@/plugins/store/state';
import {
    writeCommittedLocalPathPluginFixture,
} from '@/plugins/store/state.testkit';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    readCurrentCommittedPluginGenerations,
} from '@/plugins/store/registry/generationStore';
import type {
    StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const PLUGIN_ID = 'acme.retained-optional-access';
const AGENT_ID = 'retained-optional-agent';
const STABLE_ACCOUNT_ACCESS_ID = 'stable-account';
const OPTIONAL_ACCOUNT_ACCESS_ID = 'retained-optional-account';
const SESSION_ID = 'session-retained-optional';
type ConnectedAccountsHostAccessRequest = Extract<
    PluginHostAccessRequestV2,
    Readonly<{ capability: 'connectedAccounts' }>
>;

function stableAccountRequest(
    serviceId: string,
): ConnectedAccountsHostAccessRequest {
    return {
        id: STABLE_ACCOUNT_ACCESS_ID,
        capability: 'connectedAccounts',
        reason: 'Keep the retained Agent Connected Accounts service available.',
        scope: {
            serviceRefs: [serviceId],
            operations: ['use'],
        },
    };
}

function optionalAccountRequest(
    serviceId: string,
): ConnectedAccountsHostAccessRequest {
    return {
        id: OPTIONAL_ACCOUNT_ACCESS_ID,
        capability: 'connectedAccounts',
        reason: 'Use the selected retained Agent Connected Account.',
        scope: {
            serviceRefs: [serviceId],
            operations: ['use'],
        },
    };
}

async function writePluginSource(input: Readonly<{
    pluginRoot: string;
    version: 'G' | 'H';
    accountServiceId: string;
    requestAuthPurpose: string;
}>): Promise<void> {
    const manifestVersion = input.version === 'G' ? '1.0.0' : '2.0.0';
    await mkdir(join(input.pluginRoot, '.happier-plugin'), {
        recursive: true,
    });
    await writeFile(
        join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: manifestVersion,
            displayName: `Retained optional ${input.version}`,
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: {
                required: [stableAccountRequest(input.accountServiceId)],
                optional: [optionalAccountRequest(input.accountServiceId)],
            },
            contributes: {
                connectedAccountDescriptors: [{
                    id: input.accountServiceId,
                    title: `Account ${input.version}`,
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{
                            id: 'manual',
                            kind: 'manual',
                            outcomeReconciliation: 'none',
                            fields: [{
                                id: 'token',
                                title: 'Token',
                                schema: { type: 'string', minLength: 1 },
                                secret: true,
                            }],
                        }],
                    },
                }],
                agents: [{
                    id: AGENT_ID,
                    title: `Retained optional Agent ${input.version}`,
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                }],
            },
        }),
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'agentRuntime.mjs'),
        [
            'export function retainedOptionalAgentFactory() {',
            '  return {',
            '    async dispose() {},',
            '    sessions: {',
            '      async open(request) {',
            '        return {',
            '          sessionId: request.sessionId,',
            '          async send() { return { status: "admitted" }; },',
            '          watch() { return { dispose() {} }; },',
            '          async dispose() {}',
            '        };',
            '      }',
            '    }',
            '  };',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'daemon.mjs'),
        [
            'import { retainedOptionalAgentFactory } from "./agentRuntime.mjs";',
            'export function activate(api) {',
            `  api.connectedAccounts.register(${JSON.stringify(input.accountServiceId)}, {`,
            '    authentication: {',
            '      modes: {',
            '        manual: {',
            '          kind: "manual",',
            '          async complete() {',
            '            return {',
            '              status: "connected",',
            '              accountId: "fixture-account",',
            '              displayName: "Fixture account",',
            '              scopes: []',
            '            };',
            '          }',
            '        }',
            '      }',
            '    },',
            '    async refresh() { return { status: "unavailable" }; },',
            '    async revoke() { return { status: "remoteUnsupported" }; },',
            '    async status() {',
            '      return { status: "connected", displayName: "Fixture account" };',
            '    },',
            '    async materialize() {',
            '      return { kind: "environment", env: {} };',
            '    }',
            '  });',
            `  api.agents.register(${JSON.stringify(AGENT_ID)}, retainedOptionalAgentFactory, {`,
            '    sessionRunnerFactory: {',
            '      module: "./agentRuntime.mjs",',
            '      export: "retainedOptionalAgentFactory",',
            '      runtimeApiVersion: 1',
            '    },',
            '    connectedAccountLaunch: {',
            '      requestAuthUses: [{',
            `        purpose: ${JSON.stringify(input.requestAuthPurpose)},`,
            '        materialization: {',
            '          kind: "httpHeaders",',
            `          origin: ${JSON.stringify(`https://${input.version.toLowerCase()}.example.test`)},`,
            '          headerNames: ["authorization"]',
            '        }',
            '      }]',
            '    }',
            '  });',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
}

async function installCurrentSource(input: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    version: string;
    optionalAccess: ReturnType<typeof createSelectedPluginOptionalAccess>;
}>): Promise<void> {
    const distribution = await createLocalPathPluginDistributionIdentity(
        input.pluginRoot,
    );
    const trust = createPluginTrustRecord({
        pluginId: PLUGIN_ID,
        distribution,
        approvedAtMs: Date.now(),
    });
    const catalogRecord = PluginStateRecordSchema.parse({
        source: {
            kind: 'path',
            locator: input.pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: input.pluginRoot,
            manifestPath: join(
                input.pluginRoot,
                '.happier-plugin',
                'plugin.json',
            ),
        },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: {
            mode: 'link',
            manifestVersion: input.version,
            installedPath: null,
            trust,
            updatePolicy: 'manual',
            optionalAccess: input.optionalAccess,
        },
        state: { enabled: true },
    });
    await writeCommittedLocalPathPluginFixture({
        happyHomeDir: input.happyHomeDir,
        pluginId: PLUGIN_ID,
        sourceRootPath: input.pluginRoot,
        plugin: catalogRecord,
    });
}

describe('retained Agent optional HostAccess', () => {
    it('admits selected G optional account access and lets H current selection narrow it', async () => {
        const happyHomeDir = await mkdtemp(join(
            tmpdir(),
            'happier-retained-optional-home-',
        ));
        const pluginRoot = await mkdtemp(join(
            tmpdir(),
            'happier-retained-optional-plugin-',
        ));
        let gRegistry: Awaited<
            ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
        > | null = null;
        let hRegistry: Awaited<
            ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
        > | null = null;
        const getBindingCalls: Array<Readonly<{
            purpose: string;
            serviceId: string;
        }>> = [];
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn<StablePluginConnectedAccountsOwner['getBinding']>(async (input) => {
                getBindingCalls.push(Object.freeze({
                    purpose: input.purpose.purpose,
                    serviceId: input.serviceRefs[0]!.localId,
                }));
                return Object.freeze({
                    purpose: input.purpose.purpose,
                    service: input.serviceRefs[0]!,
                    account: Object.freeze({
                        service: input.serviceRefs[0]!,
                        accountId: 'retained-optional-test-account',
                    }),
                    target: Object.freeze({
                        kind: 'group' as const,
                        displayName: 'Selected account',
                    }),
                });
            }),
            requestSelection: vi.fn<StablePluginConnectedAccountsOwner['requestSelection']>(async () => {
                throw new Error('Unexpected connected-account selection');
            }),
            materialize: vi.fn<StablePluginConnectedAccountsOwner['materialize']>(async () => {
                throw new Error('Unexpected connected-account materialization');
            }),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn<StablePluginConnectedAccountsOwner['watch']>(
                () => Object.freeze({ dispose() {} }),
            ),
        }) satisfies StablePluginConnectedAccountsOwner;
        try {
            await writePluginSource({
                pluginRoot,
                version: 'G',
                accountServiceId: 'account-g',
                requestAuthPurpose: 'request-auth-g',
            });
            const selectedGOptionalAccess = createSelectedPluginOptionalAccess({
                pluginId: PLUGIN_ID,
                declarations: [optionalAccountRequest('account-g')],
                decisions: [{
                    accessId: OPTIONAL_ACCOUNT_ACCESS_ID,
                    selected: true,
                }],
                selectedAtMs: 1,
            });
            await installCurrentSource({
                happyHomeDir,
                pluginRoot,
                version: '1.0.0',
                optionalAccess: selectedGOptionalAccess,
            });
            gRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                generation: 1,
                connectedAccounts,
            });
            await gRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            const binding = gRegistry.agentRuntimesByAgentId
                .get(AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!binding) {
                throw new Error('Expected retained G Agent runner binding');
            }
            const createRetainedG =
                gRegistry.createRetainedRunnerAgentInvocationServices;
            if (!createRetainedG) {
                throw new Error('Expected retained G Agent services factory');
            }
            const selectedGServices = await createRetainedG({
                binding,
                sessionId: SESSION_ID,
                correlationId: 'retained-g-selected-optional',
                cwd: pluginRoot,
                environment: Object.freeze({}),
                providerBindingActive: false,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(
                selectedGServices.services.connectedAccounts.getBinding(
                    OPTIONAL_ACCOUNT_ACCESS_ID,
                ),
            ).resolves.toMatchObject({
                purpose: OPTIONAL_ACCOUNT_ACCESS_ID,
                service: {
                    pluginId: PLUGIN_ID,
                    localId: 'account-g',
                },
            });
            expect(getBindingCalls).toEqual([{
                purpose: OPTIONAL_ACCOUNT_ACCESS_ID,
                serviceId: 'account-g',
            }]);

            await writePluginSource({
                pluginRoot,
                version: 'H',
                accountServiceId: 'account-h',
                requestAuthPurpose: 'request-auth-h',
            });
            const selectedHNarrowerOptionalAccess =
                createSelectedPluginOptionalAccess({
                    pluginId: PLUGIN_ID,
                    declarations: [optionalAccountRequest('account-h')],
                    decisions: [{
                        accessId: OPTIONAL_ACCOUNT_ACCESS_ID,
                        selected: true,
                    }],
                    selectedAtMs: 2,
                });
            await installCurrentSource({
                happyHomeDir,
                pluginRoot,
                version: '2.0.0',
                optionalAccess: selectedHNarrowerOptionalAccess,
            });
            const hGenerationAuthority =
                await readCurrentCommittedPluginGenerations(
                    resolvePluginStorePaths({ happyHomeDir }),
                    { isolateInvalidInstalledGenerations: true },
                );
            if (!hGenerationAuthority) {
                throw new Error('Expected current H generation authority');
            }
            hRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                generation: 2,
                generationAuthority: hGenerationAuthority,
                connectedAccounts,
            });
            await hRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            expect(
                hRegistry.contributes.agentDefinitionsById
                    .get(AGENT_ID)
                    ?.catalogEntry
                    .connectedAccountRequestAuthUses,
            ).toMatchObject([{
                purpose: 'request-auth-h',
            }]);
            const acquireRetainedGContributions =
                hRegistry.acquireRetainedRunnerAgentPurposeContributions;
            expect(acquireRetainedGContributions).toBeTypeOf('function');
            if (!acquireRetainedGContributions) {
                throw new Error('Expected exact retained G Agent purpose contributions');
            }
            const retainedGContributions = await acquireRetainedGContributions({
                binding,
                pluginHardRevocationRevision: 0,
            });
            expect(retainedGContributions).not.toBeNull();
            if (!retainedGContributions) {
                throw new Error('Expected retained G Agent purpose contributions');
            }
            expect(
                retainedGContributions.contributes.agentDefinitionsById
                    .get(AGENT_ID)
                    ?.catalogEntry
                    .connectedAccountRequestAuthUses,
            ).toMatchObject([{
                purpose: 'request-auth-g',
            }]);
            expect(retainedGContributions.contributes.actions).toEqual([]);
            expect(retainedGContributions.contributes.agents).toHaveLength(1);
            expect(retainedGContributions.isCurrent()).toBe(true);
            await retainedGContributions.release();
            expect(retainedGContributions.isCurrent()).toBe(false);
            const createRetainedThroughH =
                hRegistry.createRetainedRunnerAgentInvocationServices;
            if (!createRetainedThroughH) {
                throw new Error('Expected retained H Agent services factory');
            }
            const narrowedGServices = await createRetainedThroughH({
                binding,
                sessionId: SESSION_ID,
                correlationId: 'retained-g-narrowed-by-h',
                cwd: pluginRoot,
                environment: Object.freeze({}),
                providerBindingActive: false,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(
                narrowedGServices.services.connectedAccounts.getBinding(
                    OPTIONAL_ACCOUNT_ACCESS_ID,
                ),
            ).rejects.toMatchObject({
                code: 'plugin_connected_account_purpose_undeclared',
            });
            expect(getBindingCalls).toEqual([{
                purpose: OPTIONAL_ACCOUNT_ACCESS_ID,
                serviceId: 'account-g',
            }]);
        } finally {
            await hRegistry?.dispose();
            await gRegistry?.dispose();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    });
});
