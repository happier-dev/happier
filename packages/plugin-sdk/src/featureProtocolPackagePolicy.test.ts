import {
    access,
    cp,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

import { runBoundedFixtureCommand } from './test-support/boundedFixtureCommand.js';
import {
    hasFeatureProtocolPackageExports,
    isFeatureProtocolPackageName,
    isPublicFeatureProtocolPackageManifest,
} from './featureProtocolPackagePolicy.js';

type DependencySection = 'dependencies' | 'peerDependencies' | 'devDependencies';

type FeatureProtocolPackageJson = Readonly<{
    name: string;
    private: boolean;
    dependencies?: Readonly<Record<string, string>>;
    peerDependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
    files?: readonly string[];
    exports: Readonly<Record<string, Readonly<{
        types: string;
        default: string;
    }>>>;
}>;

type FeatureProtocolPackageFixture = Readonly<{
    packageJson: FeatureProtocolPackageJson;
    sources: Readonly<Record<string, string>>;
}>;

type StaticModuleReferenceKind =
    | 'default'
    | 'dynamic'
    | 'export-all'
    | 'import-equals'
    | 'import-type'
    | 'named'
    | 'namespace'
    | 're-export'
    | 'require'
    | 'side-effect';

type StaticModuleReference = Readonly<{
    specifier: string;
    kind: StaticModuleReferenceKind;
    names: readonly string[];
}>;

const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const SDK_PROTOCOL_SUBPATH = `${SDK_PACKAGE_NAME}/protocol`;
const SDK_CONTRIBUTIONS_SUBPATH = `${SDK_PACKAGE_NAME}/contributions`;
const FEATURE_PROTOCOL_TEST_ONLY_SDK_IMPORT_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    [SDK_PACKAGE_NAME]: new Set([
        'definePlugin',
    ]),
    // These validation helpers support only test-harness parity vectors. A
    // published feature protocol must continue to declare portable schema
    // facts rather than compile operational validators at runtime.
    [`${SDK_PACKAGE_NAME}/manifest`]: new Set([
        'compilePluginJsonSchema',
        'isValidPluginJsonSchemaValue',
    ]),
});

/**
 * Public `testing/v1` is emitted package code, so it keeps every production
 * safety fence. It may use only this one structural comparison primitive when
 * checking an emitted protocol declaration against its canonical schema.
 */
const FEATURE_PROTOCOL_PUBLIC_TESTING_V1_SDK_IMPORT_ALLOWLIST: Readonly<
    Record<string, ReadonlySet<string>>
> = Object.freeze({
    [SDK_PROTOCOL_SUBPATH]: new Set([
        'pluginJsonValuesEqual',
    ]),
});

type FeatureProtocolProtocolAuthoringImportAudience =
    | 'feature-protocol'
    | 'feature-or-host-implementation'
    | 'target-authoring';

/**
 * The public protocol and contributions barrels are intentionally broader than the
 * reusable feature-protocol dependency contract. This is the sole
 * classification owner: the allowlist below is derived from it, and README
 * documents its two public-but-not-feature-protocol symbols.
 */
const FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE = Object.freeze({
    PluginJsonSchema: 'feature-protocol',
    ProtocolArrayOptions: 'feature-protocol',
    ProtocolComposableSchema: 'feature-protocol',
    ProtocolComposerRefV1: 'feature-protocol',
    ProtocolComposerRefV1Schema: 'feature-protocol',
    ProtocolJsonValue: 'feature-protocol',
    ProtocolJsonValueOptions: 'feature-protocol',
    ProtocolNumberOptions: 'feature-protocol',
    ProtocolObjectEvolutionPolicy: 'feature-protocol',
    ProtocolObjectOptions: 'feature-protocol',
    ProtocolSchemaInput: 'feature-protocol',
    ProtocolSchemaSafeParseResult: 'feature-protocol',
    ProtocolStringOptions: 'feature-protocol',
    ProtocolUniqueJsonArrayOptions: 'feature-protocol',
    ProtocolUtf8StringOptions: 'feature-protocol',
    ProtocolValidationError: 'feature-protocol',
    ProtocolValidationIssue: 'feature-protocol',
    ContributionActionDangerLevel: 'feature-protocol',
    ContributionActionSurface: 'feature-protocol',
    ContributionAuthorDefinition: 'feature-protocol',
    ContributionAuthorTargets: 'feature-protocol',
    ContributionContributeInput: 'feature-protocol',
    ContributionOperationBindings: 'feature-protocol',
    ContributionOperationDefinition: 'feature-protocol',
    ContributionOperationRole: 'feature-protocol',
    ContributionPointAuthorDefinition: 'feature-protocol',
    ContributionPointOptions: 'feature-protocol',
    ContributionProtocol: 'feature-protocol',
    ContributionProtocolDefinition: 'feature-protocol',
    ContributionProtocolManifest: 'feature-protocol',
    ContributionSurfaceBinding: 'feature-protocol',
    ContributionSurfaceBindings: 'feature-protocol',
    ContributionSurfaceDefinition: 'feature-protocol',
    ContributionSurfaceFallback: 'feature-protocol',
    ContributionSurfaceHandle: 'feature-protocol',
    ContributionSurfaceIcon: 'feature-protocol',
    ContributionSurfaceLocalizedString: 'feature-protocol',
    ContributionSurfaceNode: 'feature-protocol',
    ContributionSurfacePresentation: 'feature-protocol',
    ContributionSurfaceRole: 'feature-protocol',
    DefinedContributionPointProtocolMap: 'feature-protocol',
    DescriptorFields: 'feature-protocol',
    IsRequiredSurfaceDefinition: 'feature-protocol',
    PublicContributionProtocol: 'feature-protocol',
    PublicContributionProtocols: 'feature-protocol',
    RequiredSurfaceRoles: 'feature-protocol',
    SchemaInput: 'feature-protocol',
    SchemaOutput: 'feature-protocol',
    SurfaceFields: 'feature-protocol',
    defineContributionPoint: 'feature-protocol',
    defineContributionProtocol: 'feature-protocol',
    defineProtocolArray: 'feature-protocol',
    defineProtocolJsonValue: 'feature-protocol',
    defineProtocolLiteral: 'feature-protocol',
    defineProtocolNumber: 'feature-protocol',
    defineProtocolObject: 'feature-protocol',
    defineProtocolString: 'feature-protocol',
    defineProtocolUnion: 'feature-protocol',
    defineProtocolUtf8String: 'feature-protocol',
    defineProtocolUniqueArray: 'feature-protocol',
    PluginTargetedContributionSelectionV1: 'feature-protocol',
    PluginTargetedContributionSelectionV1Schema: 'feature-protocol',
    // This is the canonical structural equality owner used by feature and host
    // implementations. A reusable business-schema package has no need to
    // compare operational payloads.
    pluginJsonValuesEqual: 'feature-or-host-implementation',
    // This belongs to a target author's `.node(...)` helper signature, not to
    // the feature-owned protocol package that declares the surface role.
    ContributionSurfaceNodeInput: 'target-authoring',
} as const satisfies Readonly<Record<string, FeatureProtocolProtocolAuthoringImportAudience>>);

const FEATURE_PROTOCOL_PROTOCOL_IMPORT_ALLOWLIST = new Set(
    Object.entries(FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE)
        .flatMap(([symbol, audience]) => (
            audience === 'feature-protocol'
            && (symbol === 'PluginJsonSchema'
                || symbol.startsWith('Protocol')
                || symbol.startsWith('defineProtocol'))
                ? [symbol]
                : []
        )),
);
const FEATURE_PROTOCOL_CONTRIBUTIONS_IMPORT_ALLOWLIST = new Set(
    Object.entries(FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE)
        .flatMap(([symbol, audience]) => (
            audience === 'feature-protocol' && !FEATURE_PROTOCOL_PROTOCOL_IMPORT_ALLOWLIST.has(symbol)
                ? [symbol]
                : []
        )),
);

/**
 * Feature protocols may consume only portable public schema facts. Keeping
 * this symbol-level allowlist here prevents a broad SDK subpath from becoming
 * an accidental service, UI, runtime, or host-API escape hatch.
 */
const FEATURE_PROTOCOL_SDK_IMPORT_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    [SDK_PROTOCOL_SUBPATH]: FEATURE_PROTOCOL_PROTOCOL_IMPORT_ALLOWLIST,
    [SDK_CONTRIBUTIONS_SUBPATH]: FEATURE_PROTOCOL_CONTRIBUTIONS_IMPORT_ALLOWLIST,
    [`${SDK_PACKAGE_NAME}/connected-accounts`]: new Set([
        'QualifiedConnectedAccountRef',
        'QualifiedConnectedAccountRefSchema',
    ]),
    [`${SDK_PACKAGE_NAME}/manifest`]: new Set([
        // The current SDK entry intentionally exposes this V1 type under its
        // public `PluginContributionIdentity` alias; do not invent a second
        // type export merely to make this policy spelling match Protocol.
        'ParsedPluginManifest',
        'PluginContributionIdentity',
        'PluginContributionIdentityV1JsonSchema',
        'PluginContributionIdentityV1Schema',
        'parsePluginManifest',
    ]),
    [`${SDK_PACKAGE_NAME}/webhooks`]: new Set([
        'PluginWebhookEndpointIdV1',
        'PluginWebhookEndpointIdV1JsonSchema',
        'PluginWebhookEndpointIdV1Schema',
        'PluginWebhookEndpointSetupV1',
        'PluginWebhookEndpointSetupV1Schema',
    ]),
    [`${SDK_PACKAGE_NAME}/sessions`]: new Set([
        'AgentPermissionIntentV1',
        'AgentPermissionIntentV1Schema',
        'SessionId',
        'SessionIdSchema',
        'SessionSpawnNewInputV2',
        'SessionSpawnNewInputV2Schema',
    ]),
    [`${SDK_PACKAGE_NAME}/automations`]: new Set([
        'AutomationIdV1',
        'AutomationIdV1Schema',
        'AutomationConversationAdmitInputV1',
        'AutomationConversationAdmitInputV1Schema',
        'AutomationConversationAdmitResultV1',
        'AutomationConversationAdmitResultV1Schema',
        'AutomationConversationResultDeliveryV1',
        'AutomationConversationResultDeliveryV1Schema',
        'AutomationResultDeliveryInputV1',
        'AutomationResultDeliveryInputV1JsonSchema',
        'AutomationResultDeliveryInputV1Schema',
        'AutomationResultDeliveryResultV1',
        'AutomationResultDeliveryResultV1JsonSchema',
        'AutomationResultDeliveryResultV1Schema',
        'AutomationResultDeliverySourceV1',
        'AutomationResultDeliverySourceV1JsonSchema',
        'AutomationResultDeliverySourceV1Schema',
    ]),
});

const FORBIDDEN_IMPLEMENTATION_PATH_SEGMENTS = new Set([
    'client',
    'clients',
    'credential',
    'credentials',
    'host',
    'network',
    'persistence',
    'polling',
    'registry',
    'registries',
    'runtime',
    'ui',
    'worker',
    'workers',
]);

const FORBIDDEN_EXTERNAL_RUNTIME_IMPORTS = new Set([
    '@happier-dev/plugin-ui',
    '@react-native-community/netinfo',
    'axios',
    'node-fetch',
    'react',
    'react-dom',
    'react-native',
    'undici',
    'ws',
]);

const FORBIDDEN_NODE_BUILTIN_IMPORTS = new Set([
    'child_process',
    'crypto',
    'fs',
    'http',
    'https',
    'net',
    'os',
    'path',
    'process',
    'timers',
    'worker_threads',
]);

const FORBIDDEN_IMPLEMENTATION_CONTENT = [
    ['network effect', /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/u],
    ['polling worker', /\b(?:setInterval|setTimeout)\s*\(/u],
    ['credential materialization', /\b(?:process\.env|Deno\.env)\b/u],
] as const;

function isFeatureProtocolExplicitTestSourcePath(path: string): boolean {
    return /\.(?:spec|test|test-support)(?:\.[cm]?[jt]sx?)?$/u.test(path);
}

function isFeatureProtocolTestHarnessPath(path: string): boolean {
    const normalized = path.split('\\').join('/');
    return /(?:^|\/)(?:test|tests)(?:\/|$)/u.test(normalized)
        || isFeatureProtocolExplicitTestSourcePath(normalized);
}

function isFeatureProtocolPublicTestingV1SourcePath(path: string): boolean {
    const normalized = path.split('\\').join('/');
    return normalized.startsWith('src/testing/v1/');
}

type FeatureProtocolSourceClassification =
    | 'emitted-package-production'
    | 'emitted-public-testing-v1-fixture'
    | 'non-emitted-test-harness'
    | 'non-production';

/**
 * This is the sole source-role classifier for feature-protocol policy. A
 * plain TypeScript source under `src/` is part of the package's emitted
 * output even when it sits beneath a test-named directory; only explicit test
 * filenames and out-of-source test harnesses receive test-only exceptions.
 */
function classifyFeatureProtocolSource(sourcePath: string): FeatureProtocolSourceClassification {
    const normalized = sourcePath.split('\\').join('/');
    if (normalized.startsWith('src/') && isFeatureProtocolExplicitTestSourcePath(normalized)) {
        return 'non-emitted-test-harness';
    }
    if (isFeatureProtocolPublicTestingV1SourcePath(normalized)) {
        return 'emitted-public-testing-v1-fixture';
    }
    if (normalized.startsWith('src/')) {
        return 'emitted-package-production';
    }
    if (isFeatureProtocolTestHarnessPath(normalized)) return 'non-emitted-test-harness';
    return 'non-production';
}

function assertFeatureProtocolPublishedArtifacts(packageJson: FeatureProtocolPackageJson): void {
    const packageFiles = packageJson.files;
    if (!packageFiles?.includes('dist')) {
        throw new Error(`${packageJson.name} must publish compiled dist through exact package files`);
    }
    for (const path of packageFiles) {
        if (isFeatureProtocolTestHarnessPath(path)) {
            throw new Error(`${packageJson.name} must not publish test harness files`);
        }
        if (path.includes('*') || path.startsWith('!')) {
            throw new Error(`${packageJson.name} must use exact package files`);
        }
        if (path === 'src' || path.startsWith('src/')) {
            throw new Error(`${packageJson.name} must not publish source or implementation files`);
        }
    }

    for (const [exportPath, target] of Object.entries(packageJson.exports)) {
        for (const artifactPath of [target.types, target.default]) {
            if (isFeatureProtocolTestHarnessPath(artifactPath)) {
                throw new Error(`${packageJson.name} must not export a test harness from ${exportPath}`);
            }
            if (!artifactPath.startsWith('./dist/')) {
                throw new Error(`${packageJson.name} must export compiled dist artifacts from ${exportPath}`);
            }
        }
    }
}

const featureProtocolFixture = {
    packageJson: {
        name: '@happier-dev/example-protocol',
        private: false,
        dependencies: {
            zod: '4.3.6',
        },
        peerDependencies: {
            '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0',
        },
        devDependencies: {
            '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0',
        },
        files: ['dist', 'package.json'],
        exports: {
            '.': {
                types: './dist/index.d.ts',
                default: './dist/index.js',
            },
            './v1': {
                types: './dist/v1.d.ts',
                default: './dist/v1.js',
            },
            './testing/v1': {
                types: './dist/testing/v1.d.ts',
                default: './dist/testing/v1.js',
            },
        },
    },
    sources: {
        'src/index.ts': "export { ExampleProtocolV1 } from './v1.js';\n",
        'src/v1.ts': "export { ExampleProtocolV1 } from './v1/provider/declarations.js';\n",
        'src/v1/provider/setup.ts': 'export type ExampleProviderSetupV1 = Readonly<{ kind: \'setup\' }>;\n',
        'src/v1/provider/connectionTest.ts': 'export type ExampleProviderConnectionTestV1 = Readonly<{ kind: \'connectionTest\' }>;\n',
        'src/v1/provider/resolution.ts': 'export type ExampleProviderResolutionV1 = Readonly<{ kind: \'resolution\' }>;\n',
        'src/v1/provider/observations.ts': 'export type ExampleProviderObservationsV1 = Readonly<{ kind: \'observations\' }>;\n',
        'src/v1/provider/delivery.ts': 'export type ExampleProviderDeliveryV1 = Readonly<{ kind: \'delivery\' }>;\n',
        'src/v1/provider/lifecycle.ts': 'export type ExampleProviderLifecycleV1 = Readonly<{ kind: \'lifecycle\' }>;\n',
        'src/v1/provider/declarations.ts': [
            "import { defineProtocolJsonValue, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';",
            "import { defineContributionPoint, defineContributionProtocol, PluginTargetedContributionSelectionV1Schema } from '@happier-dev/plugin-sdk/contributions';",
            "import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';",
            "import { parsePluginManifest, PluginContributionIdentityV1JsonSchema, PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';",
            "import { PluginWebhookEndpointIdV1JsonSchema, PluginWebhookEndpointIdV1Schema, PluginWebhookEndpointSetupV1Schema } from '@happier-dev/plugin-sdk/webhooks';",
            "import { AgentPermissionIntentV1Schema, SessionIdSchema, SessionSpawnNewInputV2Schema } from '@happier-dev/plugin-sdk/sessions';",
            "import { AutomationResultDeliveryInputV1JsonSchema, AutomationResultDeliveryInputV1Schema, AutomationResultDeliveryResultV1Schema, AutomationResultDeliverySourceV1Schema } from '@happier-dev/plugin-sdk/automations';",
            "import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';",
            "import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';",
            "import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';",
            "import type { ParsedPluginManifest, PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';",
            "import type { PluginWebhookEndpointIdV1, PluginWebhookEndpointSetupV1 } from '@happier-dev/plugin-sdk/webhooks';",
            "import type { AgentPermissionIntentV1, SessionId, SessionSpawnNewInputV2 } from '@happier-dev/plugin-sdk/sessions';",
            "import type { AutomationResultDeliveryInputV1 } from '@happier-dev/plugin-sdk/automations';",
            '',
            'const exampleSchema = defineProtocolObject({',
            '    id: defineProtocolString({ minLength: 1 }),',
            '    providerConfig: defineProtocolJsonValue(),',
            "}, { policy: 'closed' });",
            '',
            'const exampleProtocol = defineContributionProtocol({',
            "    id: 'example-provider',",
            '    version: 1,',
            '    operations: {',
            '        setup: {',
            '            required: true,',
            "            input: { kind: 'protocolDefined', schema: exampleSchema },",
            '            resultSchema: exampleSchema,',
            "            action: { surface: 'plugin', dangerLevel: 'safe' },",
            '        },',
            '    },',
            '});',
            '',
            'export type ExampleProtocolFactsV1 = Readonly<{',
            '    jsonSchema: PluginJsonSchema;',
            '    selection: PluginTargetedContributionSelectionV1;',
            '    account: QualifiedConnectedAccountRef;',
            '    contribution: PluginContributionIdentity;',
            '    parsedManifest: ParsedPluginManifest;',
            '    webhookEndpointId: PluginWebhookEndpointIdV1;',
            '    webhook: PluginWebhookEndpointSetupV1;',
            '    permission: AgentPermissionIntentV1;',
            '    sessionId: SessionId;',
            '    spawn: SessionSpawnNewInputV2;',
            '    delivery: AutomationResultDeliveryInputV1;',
            '}>;',
            '',
            'export const ExampleProtocolV1 = Object.freeze({',
            '    point: defineContributionPoint([exampleProtocol]),',
            '    selectionSchema: PluginTargetedContributionSelectionV1Schema,',
            '    accountSchema: QualifiedConnectedAccountRefSchema,',
            '    contributionSchema: PluginContributionIdentityV1Schema,',
            '    contributionJsonSchema: PluginContributionIdentityV1JsonSchema,',
            '    parseManifest: parsePluginManifest,',
            '    webhookEndpointIdSchema: PluginWebhookEndpointIdV1Schema,',
            '    webhookEndpointIdJsonSchema: PluginWebhookEndpointIdV1JsonSchema,',
            '    webhookSchema: PluginWebhookEndpointSetupV1Schema,',
            '    permissionSchema: AgentPermissionIntentV1Schema,',
            '    sessionIdSchema: SessionIdSchema,',
            '    spawnSchema: SessionSpawnNewInputV2Schema,',
            '    deliverySchema: AutomationResultDeliveryInputV1Schema,',
            '    deliveryJsonSchema: AutomationResultDeliveryInputV1JsonSchema,',
            '    deliveryResultSchema: AutomationResultDeliveryResultV1Schema,',
            '    deliverySourceSchema: AutomationResultDeliverySourceV1Schema,',
            '});',
            '',
        ].join('\n'),
        'src/v1/provider/contributionPoint.ts': "export { ExampleProtocolV1 } from './declarations.js';\n",
        'src/testing/v1.ts': "export { ExampleProtocolV1 } from '../v1.js';\n",
    },
} as const satisfies FeatureProtocolPackageFixture;

/**
 * The source is deliberately small, but it compiles only against the real
 * built SDK protocol and contributions closure staged below. It is not an SDK stub:
 * this keeps the cross-copy test honest about published declaration/runtime
 * resolution while retaining a small, discriminating wire contract.
 */
const featureProtocolWireFixture = {
    packageJson: {
        name: '@happier-dev/feature-wire-protocol',
        private: false,
        peerDependencies: {
            [SDK_PACKAGE_NAME]: '>=0.0.0 <1.0.0',
        },
        devDependencies: {
            [SDK_PACKAGE_NAME]: '>=0.0.0 <1.0.0',
        },
        files: ['dist', 'package.json'],
        exports: {
            '.': {
                types: './dist/index.d.ts',
                default: './dist/index.js',
            },
            './v1': {
                types: './dist/v1.d.ts',
                default: './dist/v1.js',
            },
            './testing/v1': {
                types: './dist/testing/v1.d.ts',
                default: './dist/testing/v1.js',
            },
        },
    },
    sources: {
        'src/index.ts': "export { FEATURE_PROTOCOL_V1, featureProtocolDefinition, parseFeatureProtocolV1, createFeatureProtocolV1 } from './v1.js';\n",
        'src/v1.ts': [
            "import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';",
            "import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';",
            "import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';",
            "import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';",
            "import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';",
            "import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';",
            "import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';",
            "import type { SessionId } from '@happier-dev/plugin-sdk/sessions';",
            '',
            'export const featureProtocolDefinition = defineContributionProtocol({',
            "    id: 'feature-wire',",
            '    version: 1,',
            '    operations: {},',
            '});',
            '',
            "export const FEATURE_PROTOCOL_V1 = Object.freeze({ id: 'happier.feature-wire', version: 1 } as const);",
            '',
            'const featureProtocolValueSchema = defineProtocolObject({',
            "    protocolId: defineProtocolLiteral('happier.feature-wire'),",
            '    version: defineProtocolLiteral(1),',
            '    payload: defineProtocolString({ minLength: 1 }),',
            "}, { policy: 'closed' });",
            '',
            'const publicFacadeCompositionSchema = defineProtocolObject({',
            '    account: QualifiedConnectedAccountRefSchema,',
            '    contribution: PluginContributionIdentityV1Schema,',
            '    sessionId: SessionIdSchema,',
            "}, { policy: 'closed' });",
            '',
            'export type PublicFacadeComposition = Readonly<{',
            '    account: QualifiedConnectedAccountRef;',
            '    contribution: PluginContributionIdentity;',
            '    sessionId: SessionId;',
            '}>;',
            '',
            'export function parsePublicFacadeComposition(value: unknown) {',
            '    return publicFacadeCompositionSchema.parse(value) satisfies PublicFacadeComposition;',
            '}',
            '',
            'export function parseFeatureProtocolV1(value: unknown) {',
            '    return featureProtocolValueSchema.parse(value);',
            '}',
            '',
            'export function createFeatureProtocolV1(payload: string) {',
            '    return parseFeatureProtocolV1({',
            '        protocolId: FEATURE_PROTOCOL_V1.id,',
            '        version: FEATURE_PROTOCOL_V1.version,',
            '        payload,',
            '    });',
            '}',
            '',
        ].join('\n'),
        'src/testing/v1.ts': "export { FEATURE_PROTOCOL_V1, featureProtocolDefinition, parseFeatureProtocolV1, createFeatureProtocolV1 } from '../v1.js';\n",
    },
} as const satisfies FeatureProtocolPackageFixture;

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const typeScriptCliPath = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
// A cold TS7 NodeNext program resolves the real built SDK closure and can
// exceed the ordinary fixture-command budget under shared CI load. Keep it
// bounded, but give the single prebuilt template a realistic compiler window.
const featureProtocolPrebuildTimeoutMs = 180_000;

type PreparedFeatureProtocolCopy = Readonly<{
    packageRoot: string;
    declaration: string;
}>;

type PreparedFeatureProtocolCopies = Readonly<{
    root: string;
    first: PreparedFeatureProtocolCopy;
    second: PreparedFeatureProtocolCopy;
}>;

function packageNameForSpecifier(specifier: string): string | undefined {
    if (!specifier.startsWith('@')) return specifier.split('/')[0];
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : undefined;
}

function readStaticModuleReferences(sourcePath: string, source: string): readonly StaticModuleReference[] {
    const references: StaticModuleReference[] = [];
    const sourceFile = ts.createSourceFile(
        sourcePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const add = (specifier: string, kind: StaticModuleReferenceKind, names: readonly string[] = []): void => {
        references.push(Object.freeze({ specifier, kind, names: Object.freeze([...names]) }));
    };
    const addImportDeclaration = (statement: ts.ImportDeclaration): void => {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
        const importClause = statement.importClause;
        if (!importClause) {
            add(statement.moduleSpecifier.text, 'side-effect');
            return;
        }
        if (importClause.name) {
            add(statement.moduleSpecifier.text, 'default');
            return;
        }
        const bindings = importClause.namedBindings;
        if (!bindings) {
            add(statement.moduleSpecifier.text, 'side-effect');
            return;
        }
        if (ts.isNamespaceImport(bindings)) {
            add(statement.moduleSpecifier.text, 'namespace');
            return;
        }
        add(
            statement.moduleSpecifier.text,
            'named',
            bindings.elements.map((element) => element.propertyName?.text ?? element.name.text),
        );
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            addImportDeclaration(node);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
                add(node.moduleSpecifier.text, 'export-all');
            } else {
                add(
                    node.moduleSpecifier.text,
                    're-export',
                    node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text),
                );
            }
        } else if (ts.isImportEqualsDeclaration(node)
            && ts.isExternalModuleReference(node.moduleReference)
            && node.moduleReference.expression
            && ts.isStringLiteral(node.moduleReference.expression)) {
            add(node.moduleReference.expression.text, 'import-equals');
        } else if (ts.isImportTypeNode(node)) {
            const argument = node.argument;
            const specifier = ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
                ? argument.literal.text
                : '<computed module specifier>';
            add(
                specifier,
                'import-type',
                node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : [],
            );
        } else if (ts.isCallExpression(node)) {
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
            if (isDynamicImport || isRequire) {
                const argument = node.arguments[0];
                add(
                    argument && ts.isStringLiteral(argument) ? argument.text : '<computed module specifier>',
                    isDynamicImport ? 'dynamic' : 'require',
                );
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return Object.freeze(references);
}

function isPublicSdkDependencyRange(value: string | undefined): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.trim() === value
        && /\d/u.test(value)
        // A peer range must resolve the named public registry package itself;
        // URLs, git shorthands, local paths, and npm aliases can redirect that
        // name to unrelated bytes even when peer/dev spellings match.
        && !/[:/\\]/u.test(value);
}

function assertFeatureProtocolSdkImport(
    packageName: string,
    sourcePath: string,
    sourceClassification: FeatureProtocolSourceClassification,
    reference: StaticModuleReference,
): void {
    const testOnlyAllowedSymbols = sourceClassification === 'non-emitted-test-harness'
        ? FEATURE_PROTOCOL_TEST_ONLY_SDK_IMPORT_ALLOWLIST[reference.specifier]
        : sourceClassification === 'emitted-public-testing-v1-fixture'
            ? FEATURE_PROTOCOL_PUBLIC_TESTING_V1_SDK_IMPORT_ALLOWLIST[reference.specifier]
            : undefined;
    if (
        testOnlyAllowedSymbols !== undefined
        && reference.kind === 'named'
        && reference.names.length > 0
        && reference.names.every((name) => testOnlyAllowedSymbols.has(name))
    ) {
        return;
    }
    if (reference.specifier === SDK_PACKAGE_NAME) {
        throw new Error(`${packageName} imports the SDK root from ${sourcePath}`);
    }
    const allowedSymbols = FEATURE_PROTOCOL_SDK_IMPORT_ALLOWLIST[reference.specifier];
    if (!allowedSymbols) {
        throw new Error(`${packageName} imports unapproved SDK subpath ${reference.specifier} from ${sourcePath}`);
    }
    if ((reference.kind !== 'named' && reference.kind !== 'import-type') || reference.names.length === 0) {
        throw new Error(`${packageName} must use named SDK imports from ${reference.specifier} in ${sourcePath}`);
    }
    for (const name of reference.names) {
        if (!allowedSymbols.has(name)) {
            const audience = FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE[
                name as keyof typeof FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE
            ];
            if (audience === 'feature-protocol') {
                // Reusable for a feature protocol, but published on the other
                // approved subpath. Saying "classified feature-protocol rather
                // than feature-protocol" would tell the author nothing.
                throw new Error(
                    `${packageName} imports public SDK symbol ${name} from ${reference.specifier}, `
                    + 'but it is published on the other approved authoring subpath',
                );
            }
            if (audience !== undefined) {
                throw new Error(
                    `${packageName} imports public SDK symbol ${name} from ${reference.specifier}, `
                    + `but it is classified ${audience} rather than feature-protocol`,
                );
            }
            throw new Error(`${packageName} imports unapproved SDK symbol ${name} from ${reference.specifier}`);
        }
    }
}

function assertFeatureProtocolDependencies(packageJson: FeatureProtocolPackageJson): void {
    const sdkPeerRange = packageJson.peerDependencies?.[SDK_PACKAGE_NAME];
    const sdkDevRange = packageJson.devDependencies?.[SDK_PACKAGE_NAME];
    if (packageJson.dependencies?.[SDK_PACKAGE_NAME] !== undefined) {
        throw new Error(`${packageJson.name} must not place ${SDK_PACKAGE_NAME} in runtime dependencies`);
    }
    if (!isPublicSdkDependencyRange(sdkPeerRange) || !isPublicSdkDependencyRange(sdkDevRange)) {
        throw new Error(`${packageJson.name} requires matching public SDK peerDependencies and devDependencies`);
    }
    if (sdkPeerRange !== sdkDevRange) {
        throw new Error(`${packageJson.name} requires matching public SDK peerDependencies and devDependencies`);
    }

    const sections: ReadonlyArray<readonly [DependencySection, Readonly<Record<string, string>>]> = [
        ['dependencies', packageJson.dependencies ?? {}],
        ['peerDependencies', packageJson.peerDependencies ?? {}],
        ['devDependencies', packageJson.devDependencies ?? {}],
    ];
    for (const [section, dependencies] of sections) {
        for (const dependencyName of Object.keys(dependencies)) {
            if (dependencyName === SDK_PACKAGE_NAME) {
                if (section === 'dependencies') {
                    throw new Error(`${packageJson.name} must not place ${SDK_PACKAGE_NAME} in runtime dependencies`);
                }
                continue;
            }
            if (dependencyName.startsWith('@happier-dev/')) {
                throw new Error(`${packageJson.name} depends on host-private ${dependencyName}`);
            }
            if (FORBIDDEN_EXTERNAL_RUNTIME_IMPORTS.has(dependencyName)) {
                throw new Error(`${packageJson.name} depends on forbidden implementation package ${dependencyName}`);
            }
        }
    }
}

function assertFeatureProtocolSourceBoundary(
    packageName: string,
    sourcePath: string,
    source: string,
): void {
    const sourceClassification = classifyFeatureProtocolSource(sourcePath);
    const isProductionSource = sourceClassification === 'emitted-package-production'
        || sourceClassification === 'emitted-public-testing-v1-fixture';
    const segments = sourcePath.split('/');
    if (isProductionSource && segments.some((segment) => FORBIDDEN_IMPLEMENTATION_PATH_SEGMENTS.has(segment))) {
        throw new Error(`${packageName} contains forbidden implementation path ${sourcePath}`);
    }

    for (const reference of readStaticModuleReferences(sourcePath, source)) {
        if (reference.kind === 'dynamic' || reference.kind === 'require' || reference.kind === 'import-equals') {
            throw new Error(`${packageName} uses forbidden dynamic module loading from ${sourcePath}`);
        }
        if (reference.specifier === '<computed module specifier>') {
            throw new Error(`${packageName} uses a non-literal module specifier from ${sourcePath}`);
        }
        if (isProductionSource
            && reference.specifier.startsWith('.')
            && isFeatureProtocolTestHarnessPath(reference.specifier)) {
            throw new Error(`${packageName} production source reaches a test harness from ${sourcePath}`);
        }
        if (
            isProductionSource
            && (reference.specifier.startsWith('node:')
                || FORBIDDEN_NODE_BUILTIN_IMPORTS.has(packageNameForSpecifier(reference.specifier) ?? ''))
        ) {
            throw new Error(`${packageName} imports host/runtime implementation from ${sourcePath}`);
        }
        if (packageNameForSpecifier(reference.specifier) === SDK_PACKAGE_NAME) {
            assertFeatureProtocolSdkImport(packageName, sourcePath, sourceClassification, reference);
            continue;
        }
        if (reference.specifier === '@happier-dev/protocol'
            || reference.specifier.startsWith('@happier-dev/protocol/')) {
            throw new Error(`${packageName} imports private @happier-dev/protocol from ${sourcePath}`);
        }
        if (isProductionSource && reference.specifier.startsWith('@happier-dev/')) {
            throw new Error(`${packageName} imports host/runtime implementation from ${sourcePath}`);
        }
        if (isProductionSource
            && FORBIDDEN_EXTERNAL_RUNTIME_IMPORTS.has(packageNameForSpecifier(reference.specifier) ?? '')) {
            throw new Error(`${packageName} imports forbidden implementation package from ${sourcePath}`);
        }
    }

    if (isProductionSource) {
        for (const [boundary, pattern] of FORBIDDEN_IMPLEMENTATION_CONTENT) {
            if (pattern.test(source)) {
                throw new Error(`${packageName} contains ${boundary} implementation in ${sourcePath}`);
            }
        }
    }
}

function assertFeatureProtocolPackageBoundary(fixture: FeatureProtocolPackageFixture): void {
    const { packageJson, sources } = fixture;
    if (!isFeatureProtocolPackageName(packageJson.name)) {
        throw new Error(`${packageJson.name} is not an @happier-dev/<feature>-protocol package`);
    }

    if (packageJson.private !== false) {
        throw new Error(`${packageJson.name} must set private: false for public feature-protocol publication`);
    }
    if (!hasFeatureProtocolPackageExports(packageJson.exports)) {
        throw new Error(`${packageJson.name} must export exactly root, /v1, and /testing/v1`);
    }

    assertFeatureProtocolPublishedArtifacts(packageJson);
    assertFeatureProtocolDependencies(packageJson);
    for (const [sourcePath, source] of Object.entries(sources)) {
        assertFeatureProtocolSourceBoundary(packageJson.name, sourcePath, source);
    }
}

function assertGenericHostDoesNotImportFeatureProtocol(
    sources: Readonly<Record<string, string>>,
): void {
    for (const [sourcePath, source] of Object.entries(sources)) {
        for (const reference of readStaticModuleReferences(sourcePath, source)) {
            const importedPackageName = packageNameForSpecifier(reference.specifier);
            if (importedPackageName && isFeatureProtocolPackageName(importedPackageName)) {
                throw new Error(`generic host imports feature protocol ${importedPackageName} from ${sourcePath}`);
            }
        }
    }
}

async function readFeatureProtocolPackageFixture(packageRoot: string): Promise<FeatureProtocolPackageFixture> {
    const sources: Record<string, string> = {};

    async function readSources(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await readSources(path);
            } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
                sources[relative(packageRoot, path).split('\\').join('/')] = await readFile(path, 'utf8');
            }
        }
    }

    for (const directory of ['src', 'test']) {
        try {
            await readSources(join(packageRoot, directory));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    const packageJson = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as FeatureProtocolPackageJson;
    return {
        packageJson,
        sources,
    };
}

async function readGenericHostSources(): Promise<Readonly<Record<string, string>>> {
    const sources: Record<string, string> = {};
    const hostRoots = [
        ['apps/cli/src/plugins', new URL('../../../apps/cli/src/plugins', import.meta.url).pathname],
        ['packages/plugin-sdk/src', new URL('.', import.meta.url).pathname],
    ] as const;

    async function readSources(hostName: string, sourceRoot: string, directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await readSources(hostName, sourceRoot, path);
            } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)
                && !/\.(?:spec|test|test-support)\.[cm]?[jt]sx?$/u.test(entry.name)) {
                const sourcePath = relative(sourceRoot, path).split('\\').join('/');
                sources[`${hostName}/${sourcePath}`] = await readFile(path, 'utf8');
            }
        }
    }
    for (const [hostName, sourceRoot] of hostRoots) {
        await readSources(hostName, sourceRoot, sourceRoot);
    }
    return sources;
}

async function runTypeScriptProject(label: string, projectPath: string, cwd: string): Promise<void> {
    await runBoundedFixtureCommand(label, cwd, [typeScriptCliPath, '-p', projectPath], {
        timeoutMs: featureProtocolPrebuildTimeoutMs,
    });
}

async function requireBuiltArtifact(path: string, description: string): Promise<void> {
    try {
        await access(path);
    } catch {
        throw new Error(`Real built SDK closure is missing ${description}: ${path}`);
    }
}

async function copyBuiltPackageArtifact(sourceRoot: string, targetRoot: string): Promise<void> {
    await Promise.all([
        requireBuiltArtifact(join(sourceRoot, 'package.json'), 'package.json'),
        requireBuiltArtifact(join(sourceRoot, 'dist'), 'dist'),
    ]);
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(join(sourceRoot, 'package.json'), join(targetRoot, 'package.json'), { force: true });
    await cp(join(sourceRoot, 'dist'), join(targetRoot, 'dist'), { force: true, recursive: true });
}

type InstalledPackageJson = Readonly<{
    dependencies?: Readonly<Record<string, string>>;
}>;

function packagePathParts(packageName: string): readonly string[] {
    const parts = packageName.split('/');
    if (packageName.startsWith('@') ? parts.length !== 2 : parts.length !== 1) {
        throw new Error(`Unsupported package name in built SDK closure: ${packageName}`);
    }
    return parts;
}

async function findInstalledDependencyRoot(
    sourcePackageRoot: string,
    packageName: string,
): Promise<string> {
    const packageParts = packagePathParts(packageName);
    let lookupRoot = sourcePackageRoot;
    while (true) {
        const candidate = join(lookupRoot, 'node_modules', ...packageParts);
        try {
            await access(join(candidate, 'package.json'));
            return candidate;
        } catch {
            const parent = dirname(lookupRoot);
            if (parent === lookupRoot) {
                throw new Error(
                    `Real built SDK closure cannot resolve ${packageName} from ${sourcePackageRoot}`,
                );
            }
            lookupRoot = parent;
        }
    }
}

async function linkBuiltRuntimeDependencyClosure(
    closureRoot: string,
    sourcePackageRoot: string,
): Promise<void> {
    const packageJson = JSON.parse(
        await readFile(join(sourcePackageRoot, 'package.json'), 'utf8'),
    ) as InstalledPackageJson;
    // The feature fixture needs a real physical SDK package plus its actual
    // declared runtime closure. Its direct dependencies can remain linked to
    // their installed copies: recursively copying workspace closures makes
    // this prebuild unbounded without making the independent package proof
    // any stronger.
    await Promise.all(Object.keys(packageJson.dependencies ?? {}).sort().map(async (packageName) => {
        const sourceDependencyRoot = await findInstalledDependencyRoot(sourcePackageRoot, packageName);
        const targetDependencyRoot = join(closureRoot, 'node_modules', ...packagePathParts(packageName));
        await mkdir(dirname(targetDependencyRoot), { recursive: true });
        await symlink(
            sourceDependencyRoot,
            targetDependencyRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }));
}

async function prepareBuiltSdkAuthoringClosure(root: string): Promise<void> {
    const sdkTarget = join(root, 'node_modules', '@happier-dev', 'plugin-sdk');

    await Promise.all([
        requireBuiltArtifact(
            join(packageRoot, 'dist', 'protocol', 'index.js'),
            'protocol runtime entrypoint',
        ),
        requireBuiltArtifact(
            join(packageRoot, 'dist', 'protocol', 'index.d.ts'),
            'protocol declaration entrypoint',
        ),
        requireBuiltArtifact(
            join(packageRoot, 'dist', 'contributions', 'index.js'),
            'contributions runtime entrypoint',
        ),
        requireBuiltArtifact(
            join(packageRoot, 'dist', 'contributions', 'index.d.ts'),
            'contributions declaration entrypoint',
        ),
    ]);
    // The SDK's package manifest—not a handwritten subset—defines the real
    // built closure staged for NodeNext declaration and runtime resolution.
    await copyBuiltPackageArtifact(packageRoot, sdkTarget);
    await linkBuiltRuntimeDependencyClosure(root, packageRoot);
}

async function writeFeatureProtocolTemplate(root: string): Promise<string> {
    const templateRoot = join(root, 'feature-protocol-template');
    for (const [relativePath, source] of Object.entries(featureProtocolWireFixture.sources)) {
        const destination = join(templateRoot, relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, source, 'utf8');
    }
    await writeFile(join(templateRoot, 'package.json'), JSON.stringify({
        ...featureProtocolWireFixture.packageJson,
        type: 'module',
    }, null, 2), 'utf8');
    const configPath = join(templateRoot, 'tsconfig.json');
    await writeFile(configPath, JSON.stringify({
        compilerOptions: {
            declaration: true,
            declarationMap: false,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmitOnError: true,
            outDir: 'dist',
            rootDir: 'src',
            strict: true,
            target: 'ES2022',
            types: [],
        },
        include: ['src/**/*.ts'],
    }, null, 2), 'utf8');
    await runTypeScriptProject('feature-protocol NodeNext prebuild', configPath, templateRoot);
    return templateRoot;
}

async function installFeatureProtocolCopy(root: string, templateRoot: string): Promise<string> {
    const copyRoot = join(root, 'node_modules', '@happier-dev', 'feature-wire-protocol');
    await mkdir(copyRoot, { recursive: true });
    await Promise.all([
        cp(join(templateRoot, 'package.json'), join(copyRoot, 'package.json'), { force: true }),
        cp(join(templateRoot, 'dist'), join(copyRoot, 'dist'), { force: true, recursive: true }),
    ]);
    return copyRoot;
}

async function prepareFeatureProtocolCopies(): Promise<PreparedFeatureProtocolCopies> {
    const root = await mkdtemp(join(tmpdir(), 'happier-feature-protocol-'));
    try {
        await prepareBuiltSdkAuthoringClosure(root);
        const templateRoot = await writeFeatureProtocolTemplate(root);

        const firstRoot = join(root, 'first');
        const secondRoot = join(root, 'second');
        const [firstPackageRoot, secondPackageRoot] = await Promise.all([
            installFeatureProtocolCopy(firstRoot, templateRoot),
            installFeatureProtocolCopy(secondRoot, templateRoot),
        ]);
        const [firstDeclaration, secondDeclaration] = await Promise.all([
            readFile(join(firstPackageRoot, 'dist', 'v1.d.ts'), 'utf8'),
            readFile(join(secondPackageRoot, 'dist', 'v1.d.ts'), 'utf8'),
        ]);

        return {
            root,
            first: { packageRoot: firstPackageRoot, declaration: firstDeclaration },
            second: { packageRoot: secondPackageRoot, declaration: secondDeclaration },
        };
    } catch (error) {
        await rm(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
        throw error;
    }
}

/**
 * TypeScript may emit either a top-level import or an inline import-type
 * query; both forms are collected so neither can smuggle an unsupported
 * workspace specifier into a published declaration.
 */
function readDeclarationWorkspaceSpecifiers(declaration: string): readonly string[] {
    return [...declaration.matchAll(
        /(?:from\s*|import\s*\(\s*)['"](@happier-dev\/[^'"]+)['"]/gu,
    )].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

let preparedFeatureProtocolCopies: PreparedFeatureProtocolCopies | undefined;
let preparedFeatureProtocolCopiesPromise: Promise<PreparedFeatureProtocolCopies> | undefined;

async function getPreparedFeatureProtocolCopies(): Promise<PreparedFeatureProtocolCopies> {
    preparedFeatureProtocolCopiesPromise ??= prepareFeatureProtocolCopies().then((copies) => {
        preparedFeatureProtocolCopies = copies;
        return copies;
    });
    return await preparedFeatureProtocolCopiesPromise;
}

afterAll(async () => {
    const root = preparedFeatureProtocolCopies?.root;
    preparedFeatureProtocolCopies = undefined;
    preparedFeatureProtocolCopiesPromise = undefined;
    if (root) await rm(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
});

describe('feature-protocol package policy', () => {
    it('keeps positive feature-protocol fixtures on the direct composable authoring contract', () => {
        const positiveFixtureSources = [
            ...Object.values(featureProtocolFixture.sources),
            ...Object.values(featureProtocolWireFixture.sources),
        ].join('\n');

        for (const retired of [
            'adoptProtocolSchema',
            'defineProtocolSchema',
            'ProtocolAuthoringSchema',
            'ProtocolJsonValueSchema',
            'PublicProtocolSchema',
        ]) {
            expect(positiveFixtureSources).not.toContain(retired);
        }
        expect(positiveFixtureSources).not.toMatch(/from\s+['"]zod['"]/u);
        const wirePackageJson: FeatureProtocolPackageJson = featureProtocolWireFixture.packageJson;
        expect(wirePackageJson.dependencies?.zod).toBeUndefined();
    });

    it('allows the exact provider schema taxonomy and approved browser-safe SDK schema imports', () => {
        expect(() => assertFeatureProtocolPackageBoundary(featureProtocolFixture)).not.toThrow();
        expect(Object.keys(featureProtocolFixture.sources)).toEqual(expect.arrayContaining([
            'src/v1/provider/setup.ts',
            'src/v1/provider/connectionTest.ts',
            'src/v1/provider/resolution.ts',
            'src/v1/provider/observations.ts',
            'src/v1/provider/delivery.ts',
            'src/v1/provider/lifecycle.ts',
            'src/v1/provider/declarations.ts',
            'src/v1/provider/contributionPoint.ts',
        ]));
    });

    it('requires explicit package exports plus matching public SDK peer and dev ranges', () => {
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                private: true,
            },
        })).toThrow('private: false');
        for (const unsupportedAlias of ['./default', './current', './latest']) {
            expect(() => assertFeatureProtocolPackageBoundary({
                ...featureProtocolFixture,
                packageJson: {
                    ...featureProtocolFixture.packageJson,
                    exports: {
                        ...featureProtocolFixture.packageJson.exports,
                        [unsupportedAlias]: featureProtocolFixture.packageJson.exports['./v1'],
                    },
                },
            })).toThrow('/testing/v1');
        }
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                files: ['dist', 'test'],
            },
        })).toThrow('must not publish test harness');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                files: ['dist', '**/*'],
            },
        })).toThrow('must use exact package files');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                exports: {
                    ...featureProtocolFixture.packageJson.exports,
                    './v1': {
                        types: './dist/v1.d.ts',
                        default: './test/v1.js',
                    },
                },
            },
        })).toThrow('must not export a test harness');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                dependencies: {
                    ...featureProtocolFixture.packageJson.dependencies,
                    [SDK_PACKAGE_NAME]: '>=0.0.0 <1.0.0',
                },
            },
        })).toThrow('runtime dependencies');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                peerDependencies: {},
            },
        })).toThrow('matching public SDK peerDependencies and devDependencies');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                devDependencies: {
                    [SDK_PACKAGE_NAME]: '0.0.0',
                },
            },
        })).toThrow('matching public SDK peerDependencies and devDependencies');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                peerDependencies: {
                    [SDK_PACKAGE_NAME]: 'https://packages.example.invalid/plugin-sdk-1.0.0.tgz',
                },
                devDependencies: {
                    [SDK_PACKAGE_NAME]: 'https://packages.example.invalid/plugin-sdk-1.0.0.tgz',
                },
            },
        })).toThrow('matching public SDK peerDependencies and devDependencies');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                dependencies: {
                    ...featureProtocolFixture.packageJson.dependencies,
                    '@happier-dev/protocol': '0.0.0',
                },
            },
        })).toThrow('host-private @happier-dev/protocol');
    });

    it('allows only named, allowlisted public SDK schema facts in feature protocol source', () => {
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/jsonValueOptions.ts': "import type { ProtocolComposableSchema, ProtocolJsonValue, ProtocolJsonValueOptions } from '@happier-dev/plugin-sdk/protocol';\nexport type ProviderConfigOptions = ProtocolJsonValueOptions;\nexport type ProviderConfigSchema = ProtocolComposableSchema<ProtocolJsonValue>;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/externalAuthoring.test.ts': "import { definePlugin } from '@happier-dev/plugin-sdk';\nvoid definePlugin;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/manifestSchemaParity.test.ts': "import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';\nvoid compilePluginJsonSchema;\nvoid isValidPluginJsonSchemaValue;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/manifestSchemaRuntime.ts': "import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';\nvoid compilePluginJsonSchema;\n",
            },
        })).toThrow('unapproved SDK symbol compilePluginJsonSchema');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                // A test-named directory is not itself a non-emitted harness:
                // this ordinary `.ts` source is included in a package's dist.
                'src/v1/test/support.ts': "import { definePlugin } from '@happier-dev/plugin-sdk';\nvoid definePlugin;\n",
            },
        })).toThrow('SDK root');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/rootServiceEscape.test.ts': "import { definePlugin, getActionSpec } from '@happier-dev/plugin-sdk';\nvoid definePlugin;\nvoid getActionSpec;\n",
            },
        })).toThrow('SDK root');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/rootImport.ts': "import { defineProtocolObject } from '@happier-dev/plugin-sdk';\nvoid defineProtocolObject;\n",
            },
        })).toThrow('SDK root');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/rootTypeImport.ts': "export type ForbiddenRootSdkType = import('@happier-dev/plugin-sdk').PluginJsonSchema;\n",
            },
        })).toThrow('SDK root');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/otherSubpath.ts': "import { getActionSpec } from '@happier-dev/plugin-sdk/actions';\nvoid getActionSpec;\n",
            },
        })).toThrow('unapproved SDK subpath');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/composerRefContributionEscape.ts': "import { ComposerRefV1Schema } from '@happier-dev/plugin-sdk/contributions';\nvoid ComposerRefV1Schema;\n",
            },
        })).toThrow('unapproved SDK symbol');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/composerRefProtocolProjection.ts': "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';\nvoid ProtocolComposerRefV1Schema;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/composerRefProtocolEscape.ts': "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/contributions';\nvoid ProtocolComposerRefV1Schema;\n",
            },
        })).toThrow('published on the other approved authoring subpath');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/composerRefUiEscape.ts': "import { ComposerRefV1Schema } from '@happier-dev/plugin-sdk/ui';\nvoid ComposerRefV1Schema;\n",
            },
        })).toThrow('unapproved SDK subpath');
        for (const [path, source] of Object.entries({
            'sdkServiceEscape.ts': "import { value } from '@happier-dev/plugin-sdk/services';\nvoid value;\n",
            'sdkRuntimeEscape.ts': "import { value } from '@happier-dev/plugin-sdk/runtime';\nvoid value;\n",
            'sdkHostEscape.ts': "import { value } from '@happier-dev/plugin-sdk/host';\nvoid value;\n",
            'sdkUiEscape.ts': "import { value } from '@happier-dev/plugin-sdk/ui';\nvoid value;\n",
            'sdkTestingEscape.ts': "import { value } from '@happier-dev/plugin-sdk/testing';\nvoid value;\n",
        })) {
            expect(() => assertFeatureProtocolPackageBoundary({
                ...featureProtocolFixture,
                sources: {
                    ...featureProtocolFixture.sources,
                    [`src/v1/provider/${path}`]: source,
                },
            })).toThrow('unapproved SDK subpath');
        }
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/nonAllowlistedSymbol.ts': "import { SessionsService } from '@happier-dev/plugin-sdk/sessions';\nvoid SessionsService;\n",
            },
        })).toThrow('unapproved SDK symbol SessionsService');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/namespace.ts': "import * as sessions from '@happier-dev/plugin-sdk/sessions';\nvoid sessions;\n",
            },
        })).toThrow('must use named SDK imports');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/sideEffect.ts': "import '@happier-dev/plugin-sdk/protocol';\n",
            },
        })).toThrow('must use named SDK imports');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/dynamic.ts': "void import('@happier-dev/plugin-sdk/protocol');\n",
            },
        })).toThrow('forbidden dynamic module loading');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/privateProtocol.ts': "import { PluginManifestV2Schema } from '@happier-dev/protocol';\nvoid PluginManifestV2Schema;\n",
            },
        })).toThrow('private @happier-dev/protocol');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/privateProtocolLeaf.ts': "import { PluginTargetedContributionSelectionV1Schema } from '@happier-dev/protocol/plugins/ui/targetedContributions';\nvoid PluginTargetedContributionSelectionV1Schema;\n",
            },
        })).toThrow('private @happier-dev/protocol');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/hostRuntime.ts': "import { readFile } from 'node:fs/promises';\nvoid readFile;\n",
            },
        })).toThrow('host/runtime implementation');
    });

    it('allows JSON equality only from public testing/v1 conformance fixtures', () => {
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/testing/v1/jsonEquality.ts': "import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';\nvoid pluginJsonValuesEqual;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/testing/v2/jsonEquality.ts': "import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';\nvoid pluginJsonValuesEqual;\n",
            },
        })).toThrow('feature-or-host-implementation');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/testing/v1/hostRuntime.ts': "import { readFile } from 'node:fs/promises';\nvoid readFile;\n",
            },
        })).toThrow('host/runtime implementation');
    });

    it('keeps broader public authoring helpers out of ordinary feature-protocol production code', () => {
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/jsonEquality.ts': "import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';\nvoid pluginJsonValuesEqual;\n",
            },
        })).toThrow('feature-or-host-implementation');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/surfaceNodeInput.ts': "import type { ContributionSurfaceNodeInput } from '@happier-dev/plugin-sdk/contributions';\nexport type SurfaceNodeInput = ContributionSurfaceNodeInput;\n",
            },
        })).toThrow('target-authoring');
    });

    it('documents every public authoring audience denied to reusable feature protocols', async () => {
        const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
        for (const [symbol, audience] of Object.entries(
            FEATURE_PROTOCOL_PROTOCOL_AUTHORING_IMPORT_AUDIENCE,
        )) {
            if (audience === 'feature-protocol') continue;
            expect(readme).toContain(`\`${symbol}\`: \`${audience}\``);
        }
    });

    it('rejects provider implementation ownership without banning provider business-schema folders', () => {
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/schemaBoundary.test.ts': "import { readFile } from 'node:fs/promises';\nvoid readFile;\n",
                'test/schemaBoundary.ts': "import { readFile } from 'node:fs/promises';\nvoid readFile;\n",
            },
        })).not.toThrow();
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/privateProtocol.test.ts': "import { PluginManifestV2Schema } from '@happier-dev/protocol';\nvoid PluginManifestV2Schema;\n",
            },
        })).toThrow('private @happier-dev/protocol');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/productionImportsTest.ts': "import './schemaBoundary.test.js';\n",
            },
        })).toThrow('test harness');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                files: ['dist', 'src'],
            },
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/schemaBoundary.test.ts': "import { readFile } from 'node:fs/promises';\nvoid readFile;\n",
            },
        })).toThrow('must not publish source or implementation files');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/observationsRuntime.ts': 'export async function poll() { return fetch(\'https://example.test\'); }\n',
            },
        })).toThrow('network effect implementation');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            sources: {
                ...featureProtocolFixture.sources,
                'src/v1/provider/polling/worker.ts': 'export const schema = null;\n',
            },
        })).toThrow('forbidden implementation path');
        expect(() => assertFeatureProtocolPackageBoundary({
            ...featureProtocolFixture,
            packageJson: {
                ...featureProtocolFixture.packageJson,
                dependencies: {
                    ...featureProtocolFixture.packageJson.dependencies,
                    axios: '^1.0.0',
                },
            },
        })).toThrow('forbidden implementation package axios');
    });

    it('rejects generic hosts that import a feature protocol instead of consuming the generic SDK seam', async () => {
        expect(() => assertGenericHostDoesNotImportFeatureProtocol({
            'src/catalog.ts': "import { ExampleProtocolV1 } from '@happier-dev/example-protocol/v1';\nvoid ExampleProtocolV1;\n",
        })).toThrow('generic host imports feature protocol @happier-dev/example-protocol');
        expect(() => assertGenericHostDoesNotImportFeatureProtocol({
            'src/catalog.ts': "import { defineContributionPoint } from '@happier-dev/plugin-sdk/contributions';\nvoid defineContributionPoint;\n",
        })).not.toThrow();
        await expect(readGenericHostSources().then(assertGenericHostDoesNotImportFeatureProtocol)).resolves.toBeUndefined();
    }, 60_000);

    it('enforces the same boundary for every feature-protocol package added to the workspace', async () => {
        const packagesRoot = new URL('../..', import.meta.url);
        const packageDirectories = await readdir(packagesRoot, { withFileTypes: true });
        for (const entry of packageDirectories) {
            if (!entry.isDirectory()) continue;
            const packageRoot = join(packagesRoot.pathname, entry.name);
            const packageJsonPath = join(packageRoot, 'package.json');
            const packageJson = await readFile(packageJsonPath, 'utf8').catch(() => null);
            if (!packageJson) continue;
            const name = (JSON.parse(packageJson) as Readonly<{ name?: unknown }>).name;
            if (!isFeatureProtocolPackageName(name)) continue;
            const fixture = await readFeatureProtocolPackageFixture(packageRoot);
            expect(isPublicFeatureProtocolPackageManifest(fixture.packageJson)).toBe(true);
            assertFeatureProtocolPackageBoundary(fixture);
        }
    });

    it('prebuilds and exchanges serialized V1 values across separately installed real SDK closures', async () => {
        const copies = await getPreparedFeatureProtocolCopies();
        for (const declaration of [copies.first.declaration, copies.second.declaration]) {
            expect(declaration).not.toMatch(/@happier-dev\/protocol(?:["/])/u);
            // Schema authoring helpers are declaration-neutral by contract
            // (`protocolAuthoring.declarationNeutrality.test.ts`), so which
            // subpaths survive depends on the published types a feature
            // protocol names. The durable fence is that every retained
            // workspace specifier is a supported public SDK subpath.
            const workspaceSpecifiers = readDeclarationWorkspaceSpecifiers(declaration);
            expect(workspaceSpecifiers).not.toEqual([]);
            expect(workspaceSpecifiers.filter((specifier) => (
                FEATURE_PROTOCOL_SDK_IMPORT_ALLOWLIST[specifier] === undefined
            ))).toEqual([]);
            expect(declaration).toMatch(
                /(?:from\s+['"]@happier-dev\/plugin-sdk\/contributions['"]|import\(['"]@happier-dev\/plugin-sdk\/contributions['"]\))/u,
            );
            expect(declaration).toContain('account: QualifiedConnectedAccountRef;');
            expect(declaration).toContain('contribution: PluginContributionIdentity;');
            expect(declaration).toContain('sessionId: SessionId;');
        }

        const first = await import(pathToFileURL(join(copies.first.packageRoot, 'dist', 'v1.js')).href);
        const second = await import(pathToFileURL(join(copies.second.packageRoot, 'dist', 'v1.js')).href);

        const firstValue = first.createFeatureProtocolV1('from-first-copy');
        const secondValue = second.parseFeatureProtocolV1(JSON.parse(JSON.stringify(firstValue)));

        expect(firstValue).toEqual({
            protocolId: 'happier.feature-wire',
            version: 1,
            payload: 'from-first-copy',
        });
        expect(secondValue).toEqual(firstValue);
        expect(secondValue).not.toBe(firstValue);
        expect(second.FEATURE_PROTOCOL_V1).not.toBe(first.FEATURE_PROTOCOL_V1);
        expect(second.featureProtocolDefinition).not.toBe(first.featureProtocolDefinition);
        expect(() => second.parseFeatureProtocolV1({
            ...firstValue,
            unexpected: true,
        })).toThrow('Protocol schema validation failed');
    }, 240_000);
});
