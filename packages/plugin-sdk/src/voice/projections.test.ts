import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import {
    VoiceCredentialSlotIdSchema as ProtocolVoiceCredentialSlotIdSchema,
    VoiceProviderContributionSchema as ProtocolVoiceProviderContributionSchema,
} from '@happier-dev/protocol/plugins/contributions/voice';
import {
    VoiceModelPackContributionV1Schema as ProtocolVoiceModelPackContributionV1Schema,
    VoiceModelPackDirectoryArtifactV1Schema as ProtocolVoiceModelPackDirectoryArtifactV1Schema,
    VoiceModelPackExecutionHostV1Schema as ProtocolVoiceModelPackExecutionHostV1Schema,
    VoiceModelPackFileArtifactV1Schema as ProtocolVoiceModelPackFileArtifactV1Schema,
    VoiceModelPackKokoroArtifactsV1Schema as ProtocolVoiceModelPackKokoroArtifactsV1Schema,
    VoiceModelPackLicenseV1Schema as ProtocolVoiceModelPackLicenseV1Schema,
    VoiceModelPackLocalIdV1Schema as ProtocolVoiceModelPackLocalIdV1Schema,
    VoiceModelPackManifestV1Schema as ProtocolVoiceModelPackManifestV1Schema,
    VoiceModelPackRuntimeV1Schema as ProtocolVoiceModelPackRuntimeV1Schema,
    VoiceModelPackSupportArtifactKindV1Schema as ProtocolVoiceModelPackSupportArtifactKindV1Schema,
    VoiceModelPackSupportArtifactV1Schema as ProtocolVoiceModelPackSupportArtifactV1Schema,
    VoiceModelPackTransducerArtifactsV1Schema as ProtocolVoiceModelPackTransducerArtifactsV1Schema,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import type {
    ConnectedAccountHttpHeadersRequest as ProtocolConnectedAccountHttpHeadersRequest,
    VoiceAvailabilityPlatform as ProtocolVoiceAvailabilityPlatform,
    VoiceConversationCapabilities as ProtocolVoiceConversationCapabilities,
    VoiceConversationProviderRole as ProtocolVoiceConversationProviderRole,
    VoiceCredentialAccessPhase as ProtocolVoiceCredentialAccessPhase,
    VoiceCredentialDeclaration as ProtocolVoiceCredentialDeclaration,
    VoiceCredentialOperationProjection as ProtocolVoiceCredentialOperationProjection,
    VoiceCredentialSlotId as ProtocolVoiceCredentialSlotId,
    VoiceProviderContribution as ProtocolVoiceProviderContribution,
    VoiceProviderSettings as ProtocolVoiceProviderSettings,
    VoiceRawCredentialGrantDeclaration as ProtocolVoiceRawCredentialGrantDeclaration,
    VoiceSettingReadinessDeclaration as ProtocolVoiceSettingReadinessDeclaration,
    VoiceSpeechCatalogDeclaration as ProtocolVoiceSpeechCatalogDeclaration,
    VoiceSpeechInputMimeType as ProtocolVoiceSpeechInputMimeType,
    VoiceSpeechProviderLimits as ProtocolVoiceSpeechProviderLimits,
    VoiceSpeechProviderRole as ProtocolVoiceSpeechProviderRole,
} from '@happier-dev/protocol';
import type {
    VoiceModelPackContributionV1 as ProtocolVoiceModelPackContributionV1,
    VoiceModelPackDirectoryArtifactV1 as ProtocolVoiceModelPackDirectoryArtifactV1,
    VoiceModelPackExecutionHostV1 as ProtocolVoiceModelPackExecutionHostV1,
    VoiceModelPackFileArtifactV1 as ProtocolVoiceModelPackFileArtifactV1,
    VoiceModelPackKokoroArtifactsV1 as ProtocolVoiceModelPackKokoroArtifactsV1,
    VoiceModelPackLicenseV1 as ProtocolVoiceModelPackLicenseV1,
    VoiceModelPackManifestV1 as ProtocolVoiceModelPackManifestV1,
    VoiceModelPackRuntimeV1 as ProtocolVoiceModelPackRuntimeV1,
    VoiceModelPackSupportArtifactKindV1 as ProtocolVoiceModelPackSupportArtifactKindV1,
    VoiceModelPackSupportArtifactV1 as ProtocolVoiceModelPackSupportArtifactV1,
    VoiceModelPackTransducerArtifactsV1 as ProtocolVoiceModelPackTransducerArtifactsV1,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import type {
    VoiceRealtimeJsonValue as ProtocolVoiceRealtimeJsonValue,
    VoiceRealtimeToolCallV1 as ProtocolVoiceRealtimeToolCallV1,
    VoiceRealtimeToolResultV1 as ProtocolVoiceRealtimeToolResultV1,
    VoiceTranscriptCanonicalEventV1 as ProtocolVoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol/voice/realtime';

import type {
    VoiceAccountOperationService as CurrentVoiceAccountOperationService,
    VoiceCredentialAccess as CurrentVoiceCredentialAccess,
    VoiceProviderRuntime as CurrentVoiceProviderRuntime,
    VoiceProvidersRegistrationApi as CurrentVoiceProvidersRegistrationApi,
    VoiceRawCredentialAccess as CurrentVoiceRawCredentialAccess,
    VoiceSettingsActionContext as CurrentVoiceSettingsActionContext,
} from './index.js';
import { VoiceRealtimeJsonValueSchema } from './client.js';
import {
    createVoiceRecordSchema,
    VoiceCredentialSlotIdSchema,
    VoiceModelPackContributionV1Schema,
    VoiceModelPackDirectoryArtifactV1Schema,
    VoiceModelPackExecutionHostV1Schema,
    VoiceModelPackFileArtifactV1Schema,
    VoiceModelPackKokoroArtifactsV1Schema,
    VoiceModelPackLicenseV1Schema,
    VoiceModelPackLocalIdV1Schema,
    VoiceModelPackManifestV1Schema,
    VoiceModelPackRuntimeV1Schema,
    VoiceModelPackSupportArtifactKindV1Schema,
    VoiceModelPackSupportArtifactV1Schema,
    VoiceModelPackTransducerArtifactsV1Schema,
    VoiceProviderContributionSchema,
    withVoiceSchemaField,
    type ConnectedAccountHttpHeadersRequest,
    type VoiceAccountOperationService,
    type VoiceAvailabilityPlatform,
    type VoiceConversationCapabilities,
    type VoiceConversationProviderRole,
    type VoiceCredentialAccess,
    type VoiceCredentialAccessPhase,
    type VoiceCredentialDeclaration,
    type VoiceCredentialOperationProjection,
    type VoiceCredentialSlotId,
    type VoiceModelPackContributionV1,
    type VoiceModelPackDirectoryArtifactV1,
    type VoiceModelPackExecutionHostV1,
    type VoiceModelPackFileArtifactV1,
    type VoiceModelPackKokoroArtifactsV1,
    type VoiceModelPackLicenseV1,
    type VoiceModelPackManifestV1,
    type VoiceModelPackRuntimeV1,
    type VoiceModelPackSupportArtifactKindV1,
    type VoiceModelPackSupportArtifactV1,
    type VoiceModelPackTransducerArtifactsV1,
    type VoiceProviderContribution,
    type VoiceProviderRuntime,
    type VoiceProviderSettings,
    type VoiceProvidersRegistrationApi,
    type VoiceRawCredentialAccess,
    type VoiceRawCredentialGrantDeclaration,
    type VoiceRealtimeJsonValue,
    type VoiceRealtimeToolCall,
    type VoiceRealtimeToolResult,
    type VoiceSettingReadinessDeclaration,
    type VoiceSchema,
    type VoiceSettingsActionContext,
    type VoiceSpeechCatalogDeclaration,
    type VoiceSpeechInputMimeType,
    type VoiceSpeechProviderLimits,
    type VoiceSpeechProviderRole,
    type VoiceTranscriptCanonicalEvent,
} from './projections.js';

const APPROVED_ROOT_VOICE_PROJECTION_EXPORTS = [
    'ConnectedAccountHttpHeadersRequest',
    'VoiceAccountOperationService',
    'VoiceAvailabilityPlatform',
    'VoiceConversationCapabilities',
    'VoiceConversationProviderRole',
    'VoiceCredentialAccess',
    'VoiceCredentialAccessPhase',
    'VoiceCredentialDeclaration',
    'VoiceCredentialOperationProjection',
    'VoiceCredentialSlotId',
    'VoiceCredentialSlotIdSchema',
    'VoiceModelPackContributionV1',
    'VoiceModelPackContributionV1Schema',
    'VoiceModelPackDirectoryArtifactV1',
    'VoiceModelPackDirectoryArtifactV1Schema',
    'VoiceModelPackExecutionHostV1',
    'VoiceModelPackExecutionHostV1Schema',
    'VoiceModelPackFileArtifactV1',
    'VoiceModelPackFileArtifactV1Schema',
    'VoiceModelPackKokoroArtifactsV1',
    'VoiceModelPackKokoroArtifactsV1Schema',
    'VoiceModelPackLicenseV1',
    'VoiceModelPackLicenseV1Schema',
    'VoiceModelPackLocalIdV1Schema',
    'VoiceModelPackManifestV1',
    'VoiceModelPackManifestV1Schema',
    'VoiceModelPackRuntimeV1',
    'VoiceModelPackRuntimeV1Schema',
    'VoiceModelPackSupportArtifactKindV1',
    'VoiceModelPackSupportArtifactKindV1Schema',
    'VoiceModelPackSupportArtifactV1',
    'VoiceModelPackSupportArtifactV1Schema',
    'VoiceModelPackTransducerArtifactsV1',
    'VoiceModelPackTransducerArtifactsV1Schema',
    'VoiceProviderContribution',
    'VoiceProviderContributionSchema',
    'VoiceProviderRuntime',
    'VoiceProviderSettings',
    'VoiceProvidersRegistrationApi',
    'VoiceRawCredentialAccess',
    'VoiceRawCredentialGrantDeclaration',
    'VoiceSchema',
    'VoiceRealtimeJsonValue',
    'VoiceRealtimeToolCall',
    'VoiceRealtimeToolResult',
    'VoiceSettingReadinessDeclaration',
    'VoiceSettingsActionContext',
    'VoiceSpeechCatalogDeclaration',
    'VoiceSpeechInputMimeType',
    'VoiceSpeechProviderLimits',
    'VoiceSpeechProviderRole',
    'VoiceTranscriptCanonicalEvent',
    'classifyVoiceProviderHttpFailure',
] as const;

const VOICE_COMPOSITION_EXPORTS = [
    'createVoiceRecordSchema',
    'withVoiceSchemaField',
] as const;

const PROTOCOL_OWNED_VOICE_DTO_PROJECTIONS = [
    {
        publicName: 'ConnectedAccountHttpHeadersRequest',
        ownerModule: '@happier-dev/protocol',
        ownerName: 'ConnectedAccountHttpHeadersRequest',
    },
    ...[
        'VoiceAvailabilityPlatform',
        'VoiceConversationCapabilities',
        'VoiceConversationProviderRole',
        'VoiceCredentialAccessPhase',
        'VoiceCredentialDeclaration',
        'VoiceCredentialOperationProjection',
        'VoiceCredentialSlotId',
        'VoiceProviderContribution',
        'VoiceProviderSettings',
        'VoiceRawCredentialGrantDeclaration',
        'VoiceSettingReadinessDeclaration',
        'VoiceSpeechCatalogDeclaration',
        'VoiceSpeechInputMimeType',
        'VoiceSpeechProviderLimits',
        'VoiceSpeechProviderRole',
    ].map((name) => ({
        publicName: name,
        ownerModule: '@happier-dev/protocol/plugins/contributions/voice',
        ownerName: name,
    })),
    ...[
        'VoiceModelPackContributionV1',
        'VoiceModelPackDirectoryArtifactV1',
        'VoiceModelPackExecutionHostV1',
        'VoiceModelPackFileArtifactV1',
        'VoiceModelPackKokoroArtifactsV1',
        'VoiceModelPackLicenseV1',
        'VoiceModelPackManifestV1',
        'VoiceModelPackRuntimeV1',
        'VoiceModelPackSupportArtifactKindV1',
        'VoiceModelPackSupportArtifactV1',
        'VoiceModelPackTransducerArtifactsV1',
    ].map((name) => ({
        publicName: name,
        ownerModule: '@happier-dev/protocol/voice/modelPacks/contributionV1',
        ownerName: name,
    })),
    {
        publicName: 'VoiceRealtimeJsonValue',
        ownerModule: '@happier-dev/protocol/voice/realtime',
        ownerName: 'VoiceRealtimeJsonValue',
    },
    {
        publicName: 'VoiceRealtimeToolCall',
        ownerModule: '@happier-dev/protocol/voice/realtime',
        ownerName: 'VoiceRealtimeToolCallV1',
    },
    {
        publicName: 'VoiceRealtimeToolResult',
        ownerModule: '@happier-dev/protocol/voice/realtime',
        ownerName: 'VoiceRealtimeToolResultV1',
    },
    {
        publicName: 'VoiceTranscriptCanonicalEvent',
        ownerModule: '@happier-dev/protocol/voice/realtime',
        ownerName: 'VoiceTranscriptCanonicalEventV1',
    },
] as const satisfies readonly Readonly<{
    publicName: string;
    ownerModule: string;
    ownerName: string;
}>[];

const SDK_OWNED_VOICE_PROJECTION_TYPE_ALIASES = [
    'VoiceAccountOperationService',
    'VoiceRawCredentialAccess',
    'VoiceCredentialAccess',
    'VoiceSettingsActionContext',
    'VoiceProviderRuntime',
    'VoiceProvidersRegistrationApi',
] as const;

type IsMutuallyAssignable<Left, Right> =
    [Left] extends [Right]
        ? [Right] extends [Left]
            ? true
            : false
        : false;

type VoiceFieldPresenceBranches =
    | Readonly<{ kind: 'list'; tools?: never }>
    | Readonly<{ kind: 'create'; tools: unknown }>
    | Readonly<{ kind: 'response'; response?: unknown }>;
type VoiceToolParameters = Readonly<Record<string, VoiceRealtimeJsonValue>>;

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
}

function sourceFile(program: ts.Program, relativePath: string): ts.SourceFile {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const source = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!source) throw new Error(`Missing ${relativePath}`);
    return source;
}

function moduleExports(program: ts.Program, relativePath: string): readonly ts.Symbol[] {
    const source = sourceFile(program, relativePath);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`Missing module symbol for ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol);
}

function canonicalSymbol(program: ts.Program, symbol: ts.Symbol): ts.Symbol {
    const checker = program.getTypeChecker();
    let current = symbol;
    while (current.flags & ts.SymbolFlags.Alias) {
        const resolved = checker.getAliasedSymbol(current);
        if (resolved === current) break;
        current = resolved;
    }
    return current;
}

function exportedSymbol(
    program: ts.Program,
    relativePath: string,
    exportName: string,
): ts.Symbol {
    const symbol = moduleExports(program, relativePath)
        .find((candidate) => candidate.name === exportName);
    if (!symbol) throw new Error(`Missing ${exportName} from ${relativePath}`);
    return canonicalSymbol(program, symbol);
}

function protocolOwnerSymbol(
    program: ts.Program,
    ownerModuleSpecifier: string,
    exportName: string,
): ts.Symbol {
    const containingFile = sourceFile(program, 'src/voice/projections.ts').fileName;
    const resolved = ts.resolveModuleName(
        ownerModuleSpecifier,
        containingFile,
        program.getCompilerOptions(),
        ts.sys,
    ).resolvedModule;
    if (!resolved) {
        throw new Error(`Unable to resolve ${ownerModuleSpecifier}`);
    }
    const ownerSource = program.getSourceFile(resolved.resolvedFileName);
    if (!ownerSource) throw new Error(`Missing resolved ${ownerModuleSpecifier} source`);
    const ownerModule = program.getTypeChecker().getSymbolAtLocation(ownerSource);
    if (!ownerModule) throw new Error(`Missing ${ownerModuleSpecifier} module symbol`);
    const symbol = program.getTypeChecker().getExportsOfModule(ownerModule)
        .find((candidate) => candidate.name === exportName);
    if (!symbol) {
        throw new Error(`Missing ${exportName} from ${ownerModuleSpecifier}`);
    }
    return canonicalSymbol(program, symbol);
}

function moduleExportNames(program: ts.Program, relativePath: string): readonly string[] {
    return moduleExports(program, relativePath)
        .map((symbol) => symbol.name)
        .sort();
}

describe('Voice package-local publication projection', () => {
    it('projects every Voice DTO through its assigned SDK boundary', () => {
        const program = createSdkProgram();
        for (const projection of PROTOCOL_OWNED_VOICE_DTO_PROJECTIONS) {
            const owner = exportedSymbol(program, 'src/voice/projections.ts', projection.publicName);
            expect(owner).toBe(protocolOwnerSymbol(
                program,
                projection.ownerModule,
                projection.ownerName,
            ));
            expect(exportedSymbol(program, 'src/voice/index.ts', projection.publicName)).toBe(owner);
        }
    }, 120_000);

    it('keeps the materialization request at the Connected Accounts public owner', () => {
        const program = createSdkProgram();
        expect(exportedSymbol(
            program,
            'src/connectedAccounts.ts',
            'ConnectedAccountMaterializationRequest',
        )).toBe(protocolOwnerSymbol(
            program,
            '@happier-dev/protocol',
            'ConnectedAccountMaterializationRequest',
        ));
    }, 120_000);

    it('contains the approved root /voice projection plus neutral composition', () => {
        const program = createSdkProgram();
        const approved = [
            ...APPROVED_ROOT_VOICE_PROJECTION_EXPORTS,
            ...VOICE_COMPOSITION_EXPORTS,
        ].sort();

        expect(moduleExportNames(program, 'src/voice/projections.ts')).toEqual(approved);
    }, 120_000);

    it('directly projects Protocol DTOs and publishes neutral Voice composition', async () => {
        const [source, publicIndexSource] = await Promise.all([
            readFile(new URL('./projections.ts', import.meta.url), 'utf8'),
            readFile(new URL('./index.public.ts', import.meta.url), 'utf8'),
        ]);
        expect(source).toContain("} from '@happier-dev/protocol/plugins/contributions/voice';");
        expect(source).toContain("} from '@happier-dev/protocol/voice/modelPacks/contributionV1';");
        expect(source).toContain("} from '@happier-dev/protocol/voice/realtime';");
        expect(source).toMatch(
            /import\s+type\s*\{[^}]*ConnectedAccountMaterializationRequest[^}]*\}\s*from\s*['"]\.\.\/connectedAccounts\.js['"]/u,
        );
        expect(source).toMatch(
            /export\s+type\s*\{[^}]*ConnectedAccountHttpHeadersRequest[^}]*\}\s*from\s*['"]\.\.\/connectedAccounts\.js['"]/u,
        );
        expect(source).toContain('export type VoiceSchema<TOutput> = Readonly<{');
        expect(source).toContain('array(): VoiceSchema<TOutput[]>;');
        expect(source).toContain('export function createVoiceRecordSchema');
        expect(source).toContain('export function withVoiceSchemaField');
        expect(publicIndexSource).toContain(
            "export { createVoiceRecordSchema, withVoiceSchemaField } from './projections.js';",
        );
        expect(source).not.toContain('@happier-dev/plugin-sdk/protocol');
        expect(source).toContain(
            'export const VoiceProviderContributionSchema: VoiceSchema<VoiceProviderContribution>',
        );
    });

    it('keeps Voice source companion declarations neutral and typed', async () => {
        const [projectionsDeclaration, clientDeclaration] = await Promise.all([
            readFile(new URL('../../dist/voice/projections.d.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../dist/voice/client.d.ts', import.meta.url), 'utf8'),
        ]);

        for (const declaration of [projectionsDeclaration, clientDeclaration]) {
            expect(declaration).not.toMatch(/\bzod\b|\b_zod\b/u);
        }
        expect(projectionsDeclaration).toContain(
            "from '@happier-dev/protocol/plugins/contributions/voice';",
        );
        expect(projectionsDeclaration).toContain(
            "from '@happier-dev/protocol/voice/realtime';",
        );
        expect(projectionsDeclaration).toContain('array(): VoiceSchema<TOutput[]>;');
        expect(clientDeclaration).toContain(
            'VoiceRealtimeJsonValueSchema: VoiceSchema<VoiceRealtimeJsonValue>',
        );
    });

    it('uses canonical Voice composition owner instead of provider-local bridges', async () => {
        const productionSources = await Promise.all([
            readFile(new URL('./projections.ts', import.meta.url), 'utf8'),
            readFile(new URL('./index.public.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../../plugins/elevenlabs/src/protocol/voice/index.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../../plugins/openai/src/ui/voice/protocol.ts', import.meta.url), 'utf8'),
        ]);

        for (const source of productionSources) {
            expect(source).not.toContain('@happier-dev/plugin-sdk/protocol');
            expect(source).not.toMatch(/\b(?:JsonValueZodAdapter|z\.custom)\b/u);
        }
    });

    it('composes canonical Voice records without manufacturing absent fields or a new quota', () => {
        const record = createVoiceRecordSchema(VoiceRealtimeJsonValueSchema);
        const withParameters = withVoiceSchemaField(record, 'parameters', record);
        const maxVoiceString = 'x'.repeat(64 * 1024);

        const absent = withParameters.parse({ kind: 'list' });
        expect(absent).toEqual({ kind: 'list' });
        expect(Object.hasOwn(absent, 'parameters')).toBe(false);
        expect(withParameters.safeParse({
            parameters: { first: maxVoiceString, second: maxVoiceString },
        }).success).toBe(true);
        expect(withParameters.safeParse({
            parameters: { value: 'x'.repeat(64 * 1024 + 1) },
        }).success).toBe(false);
    });

    it('preserves required, optional, forbidden, and absent fields across Voice unions', () => {
        const assertPresenceTyping = (
            base: VoiceSchema<VoiceFieldPresenceBranches>,
            parameters: VoiceSchema<VoiceToolParameters>,
        ): void => {
            const composed = withVoiceSchemaField(base, 'tools', parameters);
            expectTypeOf<IsMutuallyAssignable<
                typeof composed,
                VoiceSchema<
                    | Readonly<{ kind: 'list'; tools?: never }>
                    | Readonly<{ kind: 'create'; tools: VoiceToolParameters }>
                    | Readonly<{ kind: 'response'; response?: unknown }>
                >
            >>().toEqualTypeOf<true>();
        };

        expectTypeOf(assertPresenceTyping).toBeFunction();
    });

    it('preserves canonical runtime identities while keeping author types local', () => {
        expect(VoiceCredentialSlotIdSchema).toBe(ProtocolVoiceCredentialSlotIdSchema);
        expect(VoiceModelPackContributionV1Schema)
            .toBe(ProtocolVoiceModelPackContributionV1Schema);
        expect(VoiceModelPackDirectoryArtifactV1Schema)
            .toBe(ProtocolVoiceModelPackDirectoryArtifactV1Schema);
        expect(VoiceModelPackExecutionHostV1Schema)
            .toBe(ProtocolVoiceModelPackExecutionHostV1Schema);
        expect(VoiceModelPackFileArtifactV1Schema)
            .toBe(ProtocolVoiceModelPackFileArtifactV1Schema);
        expect(VoiceModelPackKokoroArtifactsV1Schema)
            .toBe(ProtocolVoiceModelPackKokoroArtifactsV1Schema);
        expect(VoiceModelPackLicenseV1Schema).toBe(ProtocolVoiceModelPackLicenseV1Schema);
        expect(VoiceModelPackLocalIdV1Schema).toBe(ProtocolVoiceModelPackLocalIdV1Schema);
        expect(VoiceModelPackManifestV1Schema).toBe(ProtocolVoiceModelPackManifestV1Schema);
        expect(VoiceModelPackRuntimeV1Schema).toBe(ProtocolVoiceModelPackRuntimeV1Schema);
        expect(VoiceModelPackSupportArtifactKindV1Schema)
            .toBe(ProtocolVoiceModelPackSupportArtifactKindV1Schema);
        expect(VoiceModelPackSupportArtifactV1Schema)
            .toBe(ProtocolVoiceModelPackSupportArtifactV1Schema);
        expect(VoiceModelPackTransducerArtifactsV1Schema)
            .toBe(ProtocolVoiceModelPackTransducerArtifactsV1Schema);
        expect(VoiceProviderContributionSchema).toBe(ProtocolVoiceProviderContributionSchema);

        expectTypeOf<VoiceAvailabilityPlatform>().toEqualTypeOf<'web' | 'ios' | 'android'>();
        expectTypeOf<VoiceConversationProviderRole>().toEqualTypeOf<
            'conversation_stt' | 'conversation_tts' | 'realtime_conversation' | 'turn_control'
        >();
        expectTypeOf<VoiceCredentialAccessPhase>()
            .toEqualTypeOf<'settings' | 'prepare' | 'connection' | 'speech'>();
        expectTypeOf<VoiceModelPackExecutionHostV1>()
            .toEqualTypeOf<'daemon' | 'native_device'>();
        expectTypeOf<VoiceRealtimeJsonValue>().toEqualTypeOf<ProtocolVoiceRealtimeJsonValue>();
        expectTypeOf<keyof VoiceRealtimeToolCall>()
            .toEqualTypeOf<keyof ProtocolVoiceRealtimeToolCallV1>();
        expectTypeOf<VoiceRealtimeToolCall['arguments']>()
            .toEqualTypeOf<VoiceRealtimeJsonValue>();
        expectTypeOf<keyof VoiceRealtimeToolResult>()
            .toEqualTypeOf<keyof ProtocolVoiceRealtimeToolResultV1>();
        expectTypeOf<VoiceRealtimeToolResult['status']>()
            .toEqualTypeOf<ProtocolVoiceRealtimeToolResultV1['status']>();
        expectTypeOf<VoiceRealtimeToolResult['output']>()
            .toEqualTypeOf<VoiceRealtimeJsonValue | undefined>();
        expectTypeOf<VoiceSpeechInputMimeType>().toEqualTypeOf<
            'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg'
        >();
        expectTypeOf<VoiceSpeechProviderRole>()
            .toEqualTypeOf<'dictation_stt' | 'conversation_stt' | 'conversation_tts'>();
        expectTypeOf<VoiceTranscriptCanonicalEvent>().toMatchTypeOf<
            ProtocolVoiceTranscriptCanonicalEventV1
        >();
        expectTypeOf<ReturnType<VoiceSchema<VoiceRealtimeJsonValue>['optional']>>()
            .toEqualTypeOf<VoiceSchema<VoiceRealtimeJsonValue | undefined>>();
        expectTypeOf<ReturnType<VoiceSchema<VoiceRealtimeJsonValue>['array']>>()
            .toEqualTypeOf<VoiceSchema<VoiceRealtimeJsonValue[]>>();

        expectTypeOf<VoiceAccountOperationService>()
            .toEqualTypeOf<CurrentVoiceAccountOperationService>();
        expectTypeOf<IsMutuallyAssignable<
            VoiceCredentialAccess<'prepare'>,
            CurrentVoiceCredentialAccess<'prepare'>
        >>().toEqualTypeOf<true>();
        expectTypeOf<IsMutuallyAssignable<
            VoiceProviderRuntime,
            CurrentVoiceProviderRuntime
        >>().toEqualTypeOf<true>();
        expectTypeOf<IsMutuallyAssignable<
            VoiceProvidersRegistrationApi,
            CurrentVoiceProvidersRegistrationApi
        >>().toEqualTypeOf<true>();
        expectTypeOf<IsMutuallyAssignable<
            VoiceRawCredentialAccess,
            CurrentVoiceRawCredentialAccess
        >>().toEqualTypeOf<true>();
        expectTypeOf<IsMutuallyAssignable<
            VoiceSettingsActionContext,
            CurrentVoiceSettingsActionContext
        >>().toEqualTypeOf<true>();
    });

    it('leaves Connected Account materialization exclusively on /connected-accounts', () => {
        const program = createSdkProgram();
        const projectionNames = new Set(moduleExportNames(program, 'src/voice/projections.ts'));
        const barrelNames = new Set(moduleExportNames(program, 'src/voice/index.ts'));
        const connectedAccountNames = new Set(
            moduleExportNames(program, 'src/connectedAccounts.ts'),
        );

        expect(projectionNames.has('ConnectedAccountMaterialization')).toBe(false);
        expect(barrelNames.has('ConnectedAccountMaterialization')).toBe(false);
        expect(connectedAccountNames.has('ConnectedAccountMaterialization')).toBe(true);
    }, 120_000);
});
