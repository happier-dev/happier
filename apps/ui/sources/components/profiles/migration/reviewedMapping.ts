import {
    LegacyProfileReviewedMappingV1Schema,
    compareProviderCanonicalStringsV1,
    isLegacyAiLaunchEndpointLikeEnvironmentNameV1,
    parseProviderManualModelInput,
    normalizeCustomProviderTemplateV1,
    type AIBackendProfile,
    type CustomProviderCredentialStyleV1,
    type LegacyProfileReviewedMappingV1,
    type ProviderWireProtocol,
} from '@happier-dev/protocol';

type SupportedMigrationProtocol = Extract<ProviderWireProtocol, 'openai-responses' | 'openai-chat' | 'anthropic'>;
export type SupportedMigrationCredentialStyle = Extract<CustomProviderCredentialStyleV1, 'bearer' | 'x-api-key'>;

export type LegacyProfileMigrationDraft = Readonly<{
    name: string;
    protocol: SupportedMigrationProtocol;
    baseUrl: string;
    credentialEnvVarName: string | null;
    credentialStyle: SupportedMigrationCredentialStyle | null;
    credentialSelectionReviewed: boolean;
    credentialCandidateEnvVarNames: readonly string[];
    manualModelsText: string;
    routingEnvironmentVariableNames: readonly string[];
}>;

export function inferLegacyProfileCredentialStyle(
    environmentVariableName: string | null,
): SupportedMigrationCredentialStyle | null {
    if (environmentVariableName === 'ANTHROPIC_API_KEY') return 'x-api-key';
    if (environmentVariableName === 'ANTHROPIC_AUTH_TOKEN'
        || environmentVariableName === 'ANTHROPIC_OAUTH_TOKEN'
        || environmentVariableName === 'OPENAI_API_KEY'
        || environmentVariableName === 'CODEX_API_KEY') return 'bearer';
    return null;
}

function inferProtocol(profile: AIBackendProfile): SupportedMigrationProtocol {
    const names = [
        ...profile.environmentVariables.map((entry) => entry.name),
        ...profile.envVarRequirements.map((entry) => entry.name),
    ];
    return names.some((name) => name.includes('ANTHROPIC')) ? 'anthropic' : 'openai-responses';
}

function isModelRoutingName(name: string): boolean {
    return /(?:^|_)MODEL(?:_|$)/u.test(name);
}

export function buildLegacyProfileMigrationDraft(input: Readonly<{
    profile: AIBackendProfile;
    secretBindings: Readonly<Record<string, string>>;
}>): LegacyProfileMigrationDraft {
    const endpoint = input.profile.environmentVariables.find((entry) =>
        isLegacyAiLaunchEndpointLikeEnvironmentNameV1(entry.name));
    const modelEntries = input.profile.environmentVariables.filter((entry) =>
        isModelRoutingName(entry.name) && entry.value.trim().length > 0);
    const secretNames = [
        ...input.profile.envVarRequirements
            .filter((entry) => entry.kind === 'secret')
            .map((entry) => entry.name),
        ...input.profile.environmentVariables
            .filter((entry) => entry.isSecret === true)
            .map((entry) => entry.name),
    ];
    const credentialCandidateEnvVarNames = [...new Set(secretNames
        .filter((name) => Boolean(input.secretBindings[name])))]
        .sort(compareProviderCanonicalStringsV1);
    const credentialEnvVarName = credentialCandidateEnvVarNames.length === 1
        ? credentialCandidateEnvVarNames[0]!
        : null;
    return {
        name: input.profile.name,
        protocol: inferProtocol(input.profile),
        baseUrl: endpoint?.value.trim() ?? '',
        credentialEnvVarName,
        credentialStyle: inferLegacyProfileCredentialStyle(credentialEnvVarName),
        credentialSelectionReviewed: credentialCandidateEnvVarNames.length <= 1,
        credentialCandidateEnvVarNames,
        manualModelsText: [...new Set(modelEntries.map((entry) => entry.value.trim()))].join('\n'),
        routingEnvironmentVariableNames: [
            ...(endpoint ? [endpoint.name] : []),
            ...modelEntries.map((entry) => entry.name),
        ],
    };
}

export function buildLegacyProfileReviewedMapping(input: Readonly<{
    draft: LegacyProfileMigrationDraft;
    connectionId: string;
    now: number;
}>): LegacyProfileReviewedMappingV1 {
    if (!input.draft.credentialSelectionReviewed) {
        throw new Error('Select the credential to move before previewing migration');
    }
    if (input.draft.credentialEnvVarName
        && !input.draft.credentialCandidateEnvVarNames.includes(input.draft.credentialEnvVarName)) {
        throw new Error('Selected migration credential is not bound to this profile');
    }
    if (input.draft.credentialEnvVarName && !input.draft.credentialStyle) {
        throw new Error('Select the credential format before previewing migration');
    }
    if (!input.draft.credentialEnvVarName && input.draft.credentialStyle) {
        throw new Error('A credential format requires a selected migration credential');
    }
    const manualModels = parseProviderManualModelInput(input.draft.manualModelsText);
    if (manualModels.rejected.length > 0) {
        throw new Error(`Review invalid manual model ids on lines: ${manualModels.rejected.map((entry) => entry.line).join(', ')}`);
    }
    const template = normalizeCustomProviderTemplateV1({
        name: input.draft.name,
        protocol: input.draft.protocol,
        baseUrl: input.draft.baseUrl,
        ...(input.draft.credentialStyle ? { credentialStyle: input.draft.credentialStyle } : {}),
        catalog: 'manual',
    });
    return LegacyProfileReviewedMappingV1Schema.parse({
        connection: {
            v: 1,
            id: input.connectionId,
            source: { kind: 'custom', template },
            role: 'named',
            displayName: input.draft.name,
            displayNameMode: 'custom',
            revision: 0,
            createdAt: input.now,
            updatedAt: input.now,
        },
        credentialMoves: input.draft.credentialEnvVarName
            ? [{
                legacyEnvVarName: input.draft.credentialEnvVarName,
                credentialSlotId: 'apiKey',
                credentialStyle: input.draft.credentialStyle!,
            }]
            : [],
        routingEnvironmentVariableNames: [...input.draft.routingEnvironmentVariableNames],
        manualModelIds: [...manualModels.accepted],
    });
}
