import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '@happier-dev/protocol';
import ts from 'typescript';

import * as sdk from './index.js';
import * as manifestSdk from './manifest.js';
import type {
    PluginManifest,
    PluginSettingsContribution,
    PromptAssetCapabilities,
    PromptAssetTypeDescriptor,
} from './manifest.js';
// @ts-expect-error -- versioned manifest types are not supported-preview exports.
import type { PluginManifestV2 } from './manifest.js';
// @ts-expect-error -- parsed manifests are host products, not author inputs.
import type { ParsedPluginManifestV2 } from './manifest.js';
// @ts-expect-error -- Provider authoring remains experimental.
import type { ProviderContributionV1 } from './manifest.js';
// @ts-expect-error -- Voice model-pack authoring remains experimental.
import type { VoiceModelPackContributionV1 } from './manifest.js';

describe('manifest authoring contract', () => {
    it('keeps the normal manifest barrel at the exact consumed unsuffixed surface', async () => {
        const sourceText = await readFile(new URL('./manifest.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            'manifest.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => {
            if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                return statement.exportClause.elements.map((element) => element.name.text);
            }
            if (
                (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
                && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
                && statement.name
            ) {
                return [statement.name.text];
            }
            return [];
        });

        expect(exportedNames.sort()).toEqual([
            'PluginManifest',
            'PluginSettingsContribution',
            'PromptAssetCapabilities',
            'PromptAssetTypeDescriptor',
        ].sort());
        expect(exportedNames.some((name) => /V\d+$/.test(name))).toBe(false);
        expect(exportedNames.some((name) => name.startsWith('Parsed'))).toBe(false);
    });

    it('keeps Agent CLI metadata structural under PluginManifest instead of sweeping protocol leaves', () => {
        const schemaNames = [
            'PluginAgentCliExecutableMetadataSchema',
            'PluginAgentCliInstallMetadataSchema',
            'PluginAgentCliManagedInstallSchema',
            'PluginAgentCliManualInstallRecipesSchema',
            'PluginAgentCliInstallCommandSchema',
            'PluginAgentCliAuthMetadataSchema',
            'PluginAgentCliAuthProbeMetadataSchema',
            'PluginAgentCliLoginLaunchSchema',
            'PluginAgentCliSourcePreferenceSchema',
            'PluginAgentCliMetadataSchema',
        ] as const;

        for (const schemaName of schemaNames) {
            expect(manifestSdk).not.toHaveProperty(schemaName);
            expect(sdk).not.toHaveProperty(schemaName);
        }

        const authoredManifest = {
            schemaVersion: 2,
            id: 'acme.cli-contract',
            version: '1.0.0',
            displayName: 'Acme CLI contract',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: {
                agents: [{
                    id: 'acme',
                    title: 'Acme',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                    },
                    cli: {
                        executable: {
                            binaryName: 'acme',
                            knownUserBinDirSuffixes: ['.acme/bin'],
                            sourcePreference: 'system-first',
                            systemCommandResolutionStrategy: 'path-first',
                        },
                        install: {
                            managed: null,
                            manual: { kind: 'none' },
                            guideUrl: 'https://example.com/acme',
                        },
                        auth: {
                            support: 'login_terminal',
                            probe: {
                                parser: 'unknown',
                                backgroundChecks: 'safe',
                                statusArgs: null,
                                envVars: [],
                            },
                            loginLaunches: [
                                { kind: 'primary', args: ['login'], initialInput: '' },
                                { kind: 'device_code', args: ['login', '--device-code'], initialInput: '' },
                            ],
                        },
                    },
                }],
            },
        } satisfies PluginManifest;
        type AgentCliMetadata = NonNullable<
            (typeof authoredManifest)['contributes']['agents'][number]['cli']
        >;
        type AgentCliLoginLaunch = AgentCliMetadata['auth']['loginLaunches'][number];
        expectTypeOf<AgentCliMetadata>().toHaveProperty('executable');
        expectTypeOf<keyof AgentCliLoginLaunch>()
            .toEqualTypeOf<'kind' | 'args' | 'initialInput'>();
        expectTypeOf<AgentCliLoginLaunch['kind']>()
            .toEqualTypeOf<'primary' | 'device_code'>();
    });

    it('keeps versioned Voice declarations and runtime escape hatches off the normal path', () => {
        expect(manifestSdk).not.toHaveProperty('PluginVoiceProviderContributionV1Schema');
        expect(sdk).not.toHaveProperty('createVoiceRuntime');
        expect(manifestSdk).not.toHaveProperty('createVoiceRuntime');
    });
    it('uses protocol-owned manifest types without an identity helper', () => {
        const input = {
            schemaVersion: 2,
            id: 'acme.sdk-helper' as const,
            version: '1.0.0',
            displayName: 'SDK Helper',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './dist/activate.js' },
            hostAccess: {
                required: [],
                optional: [],
            },
            contributes: {
                events: [
                    {
                        id: 'review/comment-written',
                        kind: 'event',
                        title: 'Review comment written',
                        payloadSchema: { type: 'object', additionalProperties: true },
                    },
                ],
                requestInterceptors: [
                    {
                        id: 'plugin-fetch-audit',
                        origins: ['https://api.example.com'],
                        priority: 100,
                    },
                ],
                systemTools: [
                    {
                        id: 'acme-tool',
                        title: 'Acme Tool',
                        executableNames: ['acme-tool'],
                    },
                ],
                managedDependencies: [
                    {
                        id: 'acme-tool',
                        title: 'Acme Tool',
                        description: 'Acme tool dependency',
                        sources: [{ kind: 'system', executableNames: ['acme-tool'] }],
                        executable: 'acme-tool',
                    },
                ],
                agents: [
                    {
                        id: 'acme.agent',
                        title: 'Acme Agent',
                        runtime: { kind: 'custom' },
                        primary: 'sessions',
                        capabilities: {
                            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                        },
                    },
                ],
            },
        } satisfies PluginManifest;

        expect(sdk).not.toHaveProperty('definePluginManifest');
        expect(manifestSdk).not.toHaveProperty('definePluginManifest');
        const manifest = input;

        expect(manifest).toBe(input);
        const literalId: 'acme.sdk-helper' = manifest.id;
        const event = manifest.contributes.events[0];
        const interceptor = manifest.contributes.requestInterceptors[0];
        const systemTool = manifest.contributes.systemTools[0];
        const agents = manifest.contributes.agents;
        expect({ literalId, event, interceptor, systemTool, agents }).toBeDefined();
    });

    it('exports the supported settings and prompt-asset contracts without versions', () => {
        expectTypeOf<PluginSettingsContribution>()
            .toEqualTypeOf<protocol.PluginSettingsContribution>();
        expectTypeOf<PromptAssetCapabilities>()
            .toEqualTypeOf<protocol.PromptAssetCapabilitiesV1>();
        expectTypeOf<PromptAssetTypeDescriptor>()
            .toEqualTypeOf<protocol.PromptAssetTypeDescriptorV1>();
    });
});

describe('settings manifest authoring contract', () => {
    it('authors generic plugin settings contributions through the public SDK', () => {
        expect(sdk).not.toHaveProperty('definePluginSettingsContribution');
        expect(manifestSdk).not.toHaveProperty('definePluginSettingsContribution');

        const contribution = {
            id: 'acme-plugin-settings',
            title: 'Acme plugin settings',
            target: { kind: 'plugin' },
            scope: 'synced',
            fields: [
                {
                    id: 'show-diagnostics',
                    title: 'Show diagnostics',
                    schema: { type: 'boolean' },
                    default: true,
                },
            ],
        } satisfies PluginSettingsContribution;

        expect(contribution).toMatchObject({
            id: 'acme-plugin-settings',
            fields: [expect.objectContaining({ id: 'show-diagnostics', default: true })],
        });
        const typedContribution: PluginSettingsContribution = contribution;
        expect(typedContribution.id).toBe('acme-plugin-settings');
    });

    it('authors Agent-targeted settings through the same public settings contract', () => {
        for (const retiredHelper of [
            'defineAgentSettingsContribution',
            'enumAgentSetting',
            'stringRecordAgentSetting',
            'agentSettingsContributionToUiDescriptor',
        ]) {
            expect(sdk).not.toHaveProperty(retiredHelper);
            expect(manifestSdk).not.toHaveProperty(retiredHelper);
        }

        const contribution = {
            id: 'agent-settings',
            title: 'Acme Agent settings',
            target: { kind: 'agent', agent: 'acme' },
            scope: 'synced',
            fields: [{
                id: 'acmeBackendMode',
                title: 'Backend mode',
                schema: { type: 'string', enum: ['managed', 'external'] },
                default: 'managed',
                presentation: {
                    control: 'select',
                    options: [
                        { value: 'managed', title: 'Managed' },
                        { value: 'external', title: 'External' },
                    ],
                },
            }],
            presentation: {
                sections: [{
                    id: 'runtime',
                    title: 'Runtime',
                    fields: ['acmeBackendMode'],
                }],
                subagentSections: [],
            },
        } satisfies PluginSettingsContribution;

        expect(contribution.target).toEqual({ kind: 'agent', agent: 'acme' });
        expect(contribution.fields[0]?.id).toBe('acmeBackendMode');
        expect(contribution.presentation.sections[0]?.fields).toEqual(['acmeBackendMode']);
    });
});
