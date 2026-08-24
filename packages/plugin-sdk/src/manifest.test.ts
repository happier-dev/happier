import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '@happier-dev/protocol';
import ts from 'typescript';

import * as sdk from './index.js';
import * as manifestSdk from './manifest.js';
import type {
    ParsedPluginManifest,
    PluginContributes,
    PluginContributionIdentity,
    PluginManifest,
    PluginManifestAuthorInput,
    PluginManifestDiagnostic,
    PluginManifestParseResult,
    PluginJsonSchemaValidator,
    PluginTestkitManifest,
    PromptAssetCapabilities,
    PromptAssetTypeDescriptor,
} from './manifest.js';
import type { PluginSettingsContribution } from './settings/index.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
/* @sdk-negative-type-case:src-manifest-test-ts-4:LS0gdmVyc2lvbmVkIG1hbmlmZXN0IHR5cGVzIGFyZSBub3Qgc3VwcG9ydGVkLXByZXZpZXcgZXhwb3J0cy4:aW1wb3J0IHR5cGUgeyBQbHVnaW5NYW5pZmVzdFYyIH0gZnJvbSAnLi9tYW5pZmVzdC5qcyc7 */
type PluginManifestV2 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-manifest-test-ts-5:LS0gdmVyc2lvbmVkIHBhcnNlZC1tYW5pZmVzdCBuYW1lcyBhcmUgbm90IHN1cHBvcnRlZCBhdXRob3IgZXhwb3J0cy4:aW1wb3J0IHR5cGUgeyBQYXJzZWRQbHVnaW5NYW5pZmVzdFYyIH0gZnJvbSAnLi9tYW5pZmVzdC5qcyc7 */
type ParsedPluginManifestV2 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-manifest-test-ts-6:LS0gUHJvdmlkZXIgYXV0aG9yaW5nIHJlbWFpbnMgZXhwZXJpbWVudGFsLg:aW1wb3J0IHR5cGUgeyBQcm92aWRlckNvbnRyaWJ1dGlvblYxIH0gZnJvbSAnLi9tYW5pZmVzdC5qcyc7 */
type ProviderContributionV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-manifest-test-ts-7:LS0gVm9pY2UgbW9kZWwtcGFjayBhdXRob3JpbmcgcmVtYWlucyBleHBlcmltZW50YWwu:aW1wb3J0IHR5cGUgeyBWb2ljZU1vZGVsUGFja0NvbnRyaWJ1dGlvblYxIH0gZnJvbSAnLi9tYW5pZmVzdC5qcyc7 */
type VoiceModelPackContributionV1 = never; /* @sdk-negative-type-case-end */

describe('manifest authoring contract', () => {
    it('accepts reusable readonly Action input-hint declarations', () => {
        const inputHints = {
            fields: [{
                path: 'repository',
                title: 'Repository',
                widget: 'text',
                required: true,
            }],
        } as const;
        const manifest = {
            schemaVersion: 2,
            id: 'acme.readonly-action-hints',
            version: '1.0.0',
            displayName: 'Readonly Action hints',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {
                actions: [{
                    id: 'select-repository',
                    title: 'Select repository',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    inputSchema: {
                        type: 'object',
                        properties: { repository: { type: 'string' } },
                    },
                    inputHints,
                    dangerLevel: 'safe',
                }],
            },
        } as const satisfies PluginManifest;

        expect(manifest.contributes.actions[0]?.inputHints).toBe(inputHints);
    });

    it('projects every node named by the declarative UI union', async () => {
        const sourceText = await readFile(new URL('./manifest.ts', import.meta.url), 'utf8');

        expect(sourceText).toContain('PluginDeclarativeCollectionListNodeV2');
        expect(sourceText).toContain('PluginDeclarativeTargetedSurfaceNodeV2');
        expect(sourceText).toContain('PluginDeclarativeTargetedSurfaceReferenceV1');
    });

    it('keeps public manifest projections free of private canonical derivation aliases', async () => {
        const sourceText = await readFile(new URL('./manifest.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            'manifest.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedType = (name: string): ts.TypeAliasDeclaration | ts.InterfaceDeclaration => {
            const declaration = sourceFile.statements.find((statement) => (
                (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
                && statement.name.text === name
            ));
            if (!declaration || (!ts.isTypeAliasDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration))) {
                throw new Error(`Expected ${name} to be declared as an exported type`);
            }
            return declaration;
        };

        const manifestSignature = exportedType('PluginManifest').getText(sourceFile);
        const contributesSignature = exportedType('PluginContributes').getText(sourceFile);
        const parsedSignature = exportedType('ParsedPluginManifest').getText(sourceFile);

        expect(manifestSignature).not.toContain('CanonicalPluginManifestInput');
        expect(manifestSignature).not.toContain('PublicPluginManifestContributes');
        expect(manifestSignature).not.toContain('PublicPluginHostAccess');
        expect(manifestSignature).not.toContain('PublicPluginRequiredHostAccessRequest');
        expect(manifestSignature).not.toContain('DeferredPublicHostAccessCapability');
        expect(contributesSignature).not.toContain('PublicParsedContributes');
        expect(parsedSignature).not.toContain('CanonicalParsedPluginManifest');
        expect(parsedSignature).not.toContain('PublicParsedHostAccess');
        expect(parsedSignature).not.toContain('PublicParsedContributes');
        expect(parsedSignature).toContain('PluginManifest');
        expect(parsedSignature).toContain('PluginContributes');
    });

    it('keeps the normal manifest barrel at the exact approved portable surface', async () => {
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
                (
                    ts.isFunctionDeclaration(statement)
                    || ts.isTypeAliasDeclaration(statement)
                    || ts.isInterfaceDeclaration(statement)
                    || ts.isVariableStatement(statement)
                )
                && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
            ) {
                if (ts.isVariableStatement(statement)) {
                    return statement.declarationList.declarations.flatMap((declaration) => (
                        ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
                    ));
                }
                return statement.name ? [statement.name.text] : [];
            }
            return [];
        });

        expect(exportedNames.sort()).toEqual([
            'AgentUiBehaviorDeclarationV1',
            'AgentUiConditionV1',
            'AgentUiComponentsDeclarationV1',
            'AgentUiExternalSessionsSourceV1',
            'AgentUiMessageDeclarationV1',
            'AgentUiRuntimeDescriptorAgentExtraIdentityV1',
            'AgentUiRuntimeDescriptorAgentExtraV1',
            'AgentUiRuntimeDescriptorLinkExtrasV1',
            'AgentUiTranscriptStorageModeV1',
            'ParsedPluginManifest',
            'PluginAgentUiContribution',
            'PluginContributes',
            'PluginContributionIdentity',
            'PluginContributionIdentityV1JsonSchema',
            'PluginContributionIdentityV1Schema',
            'PluginContributionReference',
            'PluginAvailabilityDescriptor',
            'PluginBrowserActionContribution',
            'PluginBrowserActionContributionInput',
            'PluginBrowserContributionDisplay',
            'PluginBrowserTargetContribution',
            'PluginBrowserTargetContributionInput',
            // The grammar's own leaf vocabularies are published because the SDK
            // now declares the declarative grammar itself: an author narrowing
            // to one of these gets a nameable SDK type instead of an anonymous
            // structural blob their own `.d.ts` cannot reprint.
            'PluginCollectionProjectedScalarFieldRefV1',
            'PluginCollectionRowCommandV1',
            'PluginDeclarativeActionNodeV2',
            'PluginDeclarativeActionPanelNodeV2',
            'PluginDeclarativeActionVariantV2',
            'PluginDeclarativeCollectionListNodeV2',
            'PluginDeclarativeComposerApplyEffectV1',
            'PluginDeclarativeControlV2',
            'PluginDeclarativeItemNodeV2',
            'PluginDeclarativeListNodeV2',
            'PluginDeclarativeMetadataEntryV2',
            'PluginDeclarativeMetadataNodeV2',
            'PluginDeclarativeNodeV2',
            'PluginDeclarativeRowNodeV2',
            'PluginDeclarativeSectionNodeV2',
            'PluginDeclarativeStateNodeV2',
            'PluginDeclarativeStateV2',
            'PluginDeclarativeTargetedSurfaceNodeV2',
            'PluginDeclarativeTargetedSurfaceReferenceV1',
            'PluginDeclarativeToneV2',
            'PluginIdJsonSchema',
            'PluginIdSchema',
            'PluginHttpMethod',
            'PluginJsonSchemaValidator',
            'PluginLocalizedStringV2',
            'PluginManifest',
            'PluginManifestAuthorInput',
            'PluginManifestDiagnostic',
            'PluginManifestParseResult',
            'PluginRequestInterceptorContribution',
            'PluginTestkitManifest',
            'PromptAssetCapabilities',
            'PromptAssetTypeDescriptor',
            'PublicHostAccessCapability',
            'compilePluginJsonSchema',
            'createPluginContributionIdentity',
            'isValidPluginJsonSchemaValue',
            'parsePluginManifest',
        ].sort());
        expect(manifestSdk).not.toHaveProperty('PLUGIN_CONTRIBUTION_CATALOG_V2');
        expect(manifestSdk).not.toHaveProperty('derivePluginDaemonContributionRegistrationRights');
        expect(manifestSdk).not.toHaveProperty('ingestPluginManifestV2');
        expect(manifestSdk).not.toHaveProperty('PluginManifestV2Schema');
        expect(manifestSdk).not.toHaveProperty('resolvePluginManifestSetReferencesV2');
    });

    it('projects the canonical JSON schema fragments through the manifest subpath', async () => {
        const sourceText = await readFile(new URL('./manifest/index.ts', import.meta.url), 'utf8');

        expect(sourceText).toContain(
            "export { PluginContributionIdentityV1JsonSchema } from '../manifest.js';",
        );
        expect(sourceText).toContain("export { PluginIdJsonSchema } from '../manifest.js';");
    });

    it('does not expose the raw Protocol manifest schema from the public manifest barrel', async () => {
        const publicBarrelSource = await readFile(
            new URL('./manifest/index.public.ts', import.meta.url),
            'utf8',
        );

        expect(publicBarrelSource).toContain(
            "export type { PluginManifestAuthorInput } from '../manifest.js';",
        );
        expect(publicBarrelSource).toContain(
            "export type { PluginTestkitManifest } from '../manifest.js';",
        );
        expect(publicBarrelSource).toContain(
            "export type { PluginDeclarativeComposerApplyEffectV1 } from '../manifest.js';",
        );
        expect(publicBarrelSource).not.toContain('PluginManifestV2Schema');
    });

    it('keeps testkit manifest input on the canonical public manifest projections', () => {
        expectTypeOf<PluginManifest>().toMatchTypeOf<PluginTestkitManifest>();
        expectTypeOf<ParsedPluginManifest>().toMatchTypeOf<PluginTestkitManifest>();
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
        } as const satisfies PluginManifest;
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
        const systemTool = manifest.contributes.systemTools[0];
        const agents = manifest.contributes.agents;
        expect({ literalId, event, systemTool, agents }).toBeDefined();
    });

    it('keeps normalized manifests distinct from mutable cold author input', () => {
        // Parsed values preserve normalized readonly/defaulted fields, so the
        // SDK must not erase that distinction by describing parser output as
        // a cold manifest just to hide Protocol output declarations.
        expectTypeOf<protocol.ParsedPluginManifestV2>()
            .not.toMatchTypeOf<PluginManifest>();
    });

    it('projects parsed Action schemas as invocation-safe non-null objects', () => {
        type ParsedAction = ParsedPluginManifest['contributes']['actions'][number];

        expectTypeOf<ParsedAction['inputSchema']>()
            .toMatchTypeOf<object | undefined>();
        expectTypeOf<ParsedAction['resultSchema']>()
            .toMatchTypeOf<object | undefined>();
        expectTypeOf<ParsedAction['dangerLevel']>()
            .toMatchTypeOf<string>();
    });

    it('projects parsed generic contribution envelopes for conformance consumers', () => {
        type ParsedContributionPoint = ParsedPluginManifest[
            'contributes'
        ]['pluginContributionPoints'][number];
        type ParsedTargetedContribution = ParsedPluginManifest[
            'contributes'
        ]['targetedPluginContributions'][number];

        expectTypeOf<ParsedContributionPoint['protocols'][number]['operations']>()
            .toMatchTypeOf<Readonly<Record<string, Readonly<{ required: boolean }>>>>();
        expectTypeOf<ParsedTargetedContribution['target']['pluginId']>()
            .toMatchTypeOf<string>();
        expectTypeOf<ParsedTargetedContribution['protocol']['version']>()
            .toMatchTypeOf<number>();
        expectTypeOf<ParsedTargetedContribution['operations']>()
            .toMatchTypeOf<Readonly<Record<string, string>>>();
    });

    it('keeps generic request-interception HostAccess deferred while publishing request policies', () => {
        type PublicRequiredHostAccess = NonNullable<
            NonNullable<PluginManifest['hostAccess']>['required']
        >[number];
        expectTypeOf<Extract<PublicRequiredHostAccess, {
            capability: 'network.intercept' | 'browser' | 'clipboard' | 'externalLinks';
        }>>().toEqualTypeOf<never>();

        const parseUntypedManifest = manifestSdk.parsePluginManifest as (
            input: unknown,
        ) => PluginManifestParseResult;
        const requestInterception = parseUntypedManifest({
            schemaVersion: 2,
            id: 'acme.request-policy-host-access',
            version: '1.0.0',
            displayName: 'Request policy HostAccess',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            hostAccess: {
                required: [{
                    id: 'intercept-api',
                    capability: 'network.intercept',
                    reason: 'Apply the declared request policy to the API.',
                    scope: { origins: ['https://intercept.example.com'] },
                }],
                optional: [],
            },
            contributes: {},
        });
        expect(requestInterception.ok).toBe(false);

        const publicRequestPolicy = manifestSdk.parsePluginManifest({
            schemaVersion: 2,
            id: 'acme.request-policy-author',
            version: '1.0.0',
            displayName: 'Request policy author',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] },
            contributes: {
                requestInterceptors: [{
                    id: 'intercept-api',
                    origins: ['https://intercept.example.com'],
                    methods: ['GET'],
                }],
            },
        });
        expect(publicRequestPolicy.ok).toBe(true);
        if (publicRequestPolicy.ok) {
            expect(publicRequestPolicy.manifest.contributes.requestInterceptors).toEqual([{
                id: 'intercept-api',
                origins: ['https://intercept.example.com'],
                methods: ['GET'],
            }]);
        }

        const deferredRequests = [
            { capability: 'browser', scope: { operations: ['read'] } },
            { capability: 'clipboard', scope: { access: ['read'] } },
            { capability: 'externalLinks', scope: { origins: ['https://links.example.com'] } },
        ] as const;

        for (const request of deferredRequests) {
            const parsed = manifestSdk.parsePluginManifest({
                schemaVersion: 2,
                id: 'acme.deferred-host-access',
                version: '1.0.0',
                displayName: 'Deferred HostAccess',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                hostAccess: {
                    required: [{ id: 'deferred-access', reason: 'Exercise the public boundary.', ...request }],
                    optional: [],
                },
                contributes: {},
            });
            expect(parsed.ok).toBe(false);
            if (!parsed.ok) {
                expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
                    code: 'plugin_manifest_invalid',
                    path: ['hostAccess', 'required', 0, 'capability'],
                    message: expect.stringContaining('deferred from public plugin authoring'),
                }));
            }
        }

        const terminal = manifestSdk.parsePluginManifest({
            schemaVersion: 2,
            id: 'acme.terminal-session-path',
            version: '1.0.0',
            displayName: 'Terminal session path',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            hostAccess: {
                required: [{
                    id: 'terminal-session-path',
                    capability: 'terminal',
                    reason: 'Use the Agent session terminal path.',
                    scope: { operations: ['open'] },
                }],
                optional: [],
            },
            contributes: {},
        });
        expect(terminal.ok).toBe(true);
    });

    it('keeps the public manifest boundary JSON-only before serialization can drop values', () => {
        class NonJsonMetadataValue {}
        const accessorBackedMetadata: Record<string, unknown> = {};
        Object.defineProperty(accessorBackedMetadata, 'poison', {
            enumerable: true,
            get() {
                return 'accessor metadata is not JSON input';
            },
        });

        for (const invalid of [
            () => undefined,
            Symbol('manifest-metadata'),
            new NonJsonMetadataValue(),
            accessorBackedMetadata,
        ]) {
            const parsed = manifestSdk.parsePluginManifest({
                schemaVersion: 2,
                id: 'acme.json-only-manifest',
                version: '1.0.0',
                displayName: 'JSON-only manifest',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                metadata: { invalid },
            });

            expect(parsed).toEqual({
                ok: false,
                diagnostics: [expect.objectContaining({
                    code: 'plugin_manifest_invalid_json',
                })],
            });
        }
    });

    it('accepts public request policies and browser contributions through the canonical manifest parser', () => {
        const parsed = manifestSdk.parsePluginManifest({
            schemaVersion: 2,
            id: 'acme.public-browser-policy',
            version: '1.0.0',
            displayName: 'Public browser policy',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {
                actions: [{
                    id: 'open-preview-action',
                    title: 'Open preview',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    inputSchema: { type: 'object' },
                    dangerLevel: 'safe',
                }],
                browserTargets: [{
                    id: 'preview-target',
                    title: 'Preview',
                    url: 'https://preview.example.test/',
                }],
                browserActions: [{
                    id: 'open-preview',
                    title: 'Open preview',
                    action: 'open-preview-action',
                    target: 'preview-target',
                }],
                requestInterceptors: [{
                    id: 'api-egress',
                    origins: ['https://api.example.test'],
                    methods: ['GET'],
                    priority: 20,
                }],
            },
        });

        expect(parsed).toMatchObject({
            ok: true,
            manifest: {
                contributes: {
                    browserTargets: [{
                        id: 'preview-target',
                        launch: 'newView',
                        profile: 'user',
                    }],
                    browserActions: [{
                        id: 'open-preview',
                        action: 'open-preview-action',
                        target: 'preview-target',
                        placement: 'toolbar',
                    }],
                    requestInterceptors: [{
                        id: 'api-egress',
                        origins: ['https://api.example.test'],
                        methods: ['GET'],
                        priority: 20,
                    }],
                },
            },
        });
    });

    it('contracts contribution-identity parsing to public parser results without validator internals', async () => {
        const sourceText = await readFile(new URL('./manifest.ts', import.meta.url), 'utf8');
        const emitted = ts.transpileDeclaration(sourceText, {
            fileName: 'manifest.ts',
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(emitted.diagnostics).toEqual([]);
        expect(emitted.outputText).toContain(
            'PluginContributionIdentityV1Schema: ProtocolComposableSchema<PluginContributionIdentity>;',
        );
        expect(emitted.outputText).toContain('PluginIdSchema: ProtocolComposableSchema<string>;');
        expect(emitted.outputText).toContain(
            "import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';",
        );
        expectTypeOf<ReturnType<ProtocolComposableSchema<string>['optional']>>()
            .toEqualTypeOf<ProtocolComposableSchema<string | undefined>>();
        expectTypeOf<ReturnType<ProtocolComposableSchema<string>['nullable']>>()
            .toEqualTypeOf<ProtocolComposableSchema<string | null>>();
        expect(emitted.outputText).not.toContain('PluginManifestComposableSchema');
        expect(emitted.outputText).not.toContain('PluginManifestOptionalSchema');
        expect(emitted.outputText).not.toMatch(/\b(?:_zod|Zod[A-Za-z])/u);
    });

    it('exports canonical manifest contribution and identity types without publishing the raw schema bypass', () => {
        expect(manifestSdk).not.toHaveProperty('PluginManifestV2Schema');
        expect(manifestSdk.compilePluginJsonSchema)
            .toBe(protocol.compilePluginJsonSchema);
        expect(manifestSdk.isValidPluginJsonSchemaValue)
            .toBe(protocol.isValidPluginJsonSchemaValue);
        expect(manifestSdk.createPluginContributionIdentity)
            .toBe(protocol.createPluginContributionIdentity);
        expect(manifestSdk.PluginContributionIdentityV1Schema)
            .toBe(protocol.PluginContributionIdentityV1Schema);
        expect((manifestSdk as Record<string, unknown>).PluginContributionIdentityV1JsonSchema)
            .toBe((protocol as Record<string, unknown>).PluginContributionIdentityV1JsonSchema);
        expect((manifestSdk as Record<string, unknown>).PluginIdJsonSchema)
            .toBe((protocol as Record<string, unknown>).PluginIdJsonSchema);
        expect(manifestSdk.PluginIdSchema)
            .toBe(protocol.PluginIdSchema);
        expectTypeOf<typeof manifestSdk.PluginContributionIdentityV1Schema>()
            .toEqualTypeOf<ProtocolComposableSchema<PluginContributionIdentity>>();
        expectTypeOf<typeof manifestSdk.PluginIdSchema>()
            .toEqualTypeOf<ProtocolComposableSchema<string>>();
        expectTypeOf<PluginContributionIdentity>()
            .toMatchTypeOf<protocol.PluginContributionIdentityV1>();
        expectTypeOf<protocol.PluginContributionIdentityV1>()
            .toMatchTypeOf<PluginContributionIdentity>();
        // The public author boundary deliberately accepts a readonly parsed
        // SDK projection for direct composition, while Protocol's raw input
        // remains mutable and internal.
        expectTypeOf<PluginManifest>()
            .not.toMatchTypeOf<protocol.PluginManifest>();
        // The mutable schema input is published only as the source type for
        // the portable readonly author projection; they must not collapse
        // into a second spelling of the same manifest contract.
        expectTypeOf<PluginManifestAuthorInput>()
            .toMatchTypeOf<PluginManifest>();
        expectTypeOf<PluginManifest>()
            .not.toEqualTypeOf<PluginManifestAuthorInput>();
        expectTypeOf<ParsedPluginManifest>()
            .toMatchTypeOf<PluginManifest>();
        expectTypeOf<NonNullable<PluginManifest['contributes']>>()
            .toHaveProperty('requestInterceptors');
        expectTypeOf<NonNullable<PluginManifest['contributes']>>()
            .toHaveProperty('browserTargets');
        expectTypeOf<NonNullable<PluginManifest['contributes']>>()
            .toHaveProperty('browserActions');
        expectTypeOf<protocol.PluginContributesV2>()
            .toMatchTypeOf<PluginContributes>();
        expectTypeOf<PluginContributes>().toHaveProperty('requestInterceptors');
        expectTypeOf<PluginContributes>().toHaveProperty('browserTargets');
        expectTypeOf<PluginContributes>().toHaveProperty('browserActions');
        // The public parsed projection keeps author-visible values readonly
        // while retaining every approved canonical contribution family.
        expectTypeOf<ParsedPluginManifest>()
            .not.toMatchTypeOf<protocol.ParsedPluginManifestV2>();
        expectTypeOf<PluginManifestDiagnostic>()
            .toEqualTypeOf<protocol.PluginManifestIngestionDiagnostic>();
        expectTypeOf<PluginManifestParseResult>()
            .not.toMatchTypeOf<protocol.PluginManifestIngestionResult>();
        expectTypeOf<PluginJsonSchemaValidator>()
            .toEqualTypeOf<protocol.PluginJsonSchemaValidator>();
        // Manifest authoring projects the Protocol shapes as readonly values,
        // so mutable Protocol values remain composable without collapsing the
        // public declaration boundary into Protocol's raw output type.
        expectTypeOf<protocol.PromptAssetCapabilities>()
            .toMatchTypeOf<PromptAssetCapabilities>();
        expectTypeOf<PromptAssetCapabilities>()
            .not.toEqualTypeOf<protocol.PromptAssetCapabilities>();
        expectTypeOf<protocol.PromptAssetTypeDescriptor>()
            .toMatchTypeOf<PromptAssetTypeDescriptor>();
        expectTypeOf<PromptAssetTypeDescriptor>()
            .not.toEqualTypeOf<protocol.PromptAssetTypeDescriptor>();

        const manifestInput = {
            schemaVersion: 2,
            id: 'acme.manifest-parser',
            version: '1.0.0',
            displayName: 'Manifest parser',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        };
        const parsed = manifestSdk.parsePluginManifest(manifestInput);
        const canonical = protocol.ingestPluginManifestV2(manifestInput);
        expect(parsed.ok).toBe(true);
        expect(canonical.ok).toBe(true);
        if (parsed.ok && canonical.ok) {
            expect(parsed.manifest).toEqual({
                ...canonical.manifest,
            });
        }

        const invalid = manifestSdk.parsePluginManifest({ schemaVersion: 2 });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
            expect(invalid.diagnostics.some((diagnostic) => (
                diagnostic.code === 'plugin_manifest_invalid'
            ))).toBe(true);
        }
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
            scope: 'account',
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
            scope: 'account',
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
