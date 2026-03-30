import type {
    McpServerBindingTargetV1,
    McpServerBindingV1,
    McpServerCatalogEntryV1,
    McpValueRefV1,
    McpServersSettingsV1,
} from '@happier-dev/protocol';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

import { upsertMcpServerWithBindingsV1 } from './mcpServerCrud';
import {
    createUniqueMcpServerName,
    createUniqueSavedSecretName,
    normalizeMcpServerNameCandidate,
    toEnvToken,
} from './mcpCatalogNaming';
import { hasImportedMcpInputResolutionIssues } from './importedMcpInputResolutionValidation';
import type { ImportedMcpDraftValueV1, ImportedMcpServerDraftV1 } from './parseImportedMcpServerJson';

export type ImportedMcpInputResolutionV1 =
    | {
        mode: 'machineEnv';
        envVarName: string;
    }
    | {
        mode: 'savedSecret';
        secretName: string;
        secretValue: string;
        secretKind?: SavedSecret['kind'];
    };

export type MaterializeImportedMcpServerDraftsResult = Readonly<{
    nextSettings: McpServersSettingsV1;
    nextSecrets: SavedSecret[];
    warnings: string[];
}>;

function resolveBindingTarget(draft: ImportedMcpServerDraftV1, defaultMachineId: string): McpServerBindingTargetV1 {
    return draft.transport === 'stdio'
        ? { t: 'machine', machineId: defaultMachineId }
        : { t: 'allMachines' };
}

function resolveInputValueRef(params: Readonly<{
    draftName: string;
    inputId: string;
    inputMappings: Record<string, ImportedMcpInputResolutionV1>;
    nextSecrets: SavedSecret[];
    nowMs: number;
    generateId: () => string;
    warnings: string[];
}>): McpValueRefV1 {
    const mapping = params.inputMappings[params.inputId];
    if (!mapping) {
        const envVarName = toEnvToken(params.inputId);
        params.warnings.push(`${params.draftName}: unresolved input "${params.inputId}" was mapped to \${${envVarName}}`);
        return { t: 'literal', v: `\${${envVarName}}` };
    }

    if (mapping.mode === 'machineEnv') {
        const envVarName = toEnvToken(mapping.envVarName);
        if (!envVarName) {
            const fallbackEnvVarName = toEnvToken(params.inputId);
            params.warnings.push(`${params.draftName}: incomplete machine env mapping for "${params.inputId}" was mapped to \${${fallbackEnvVarName}}`);
            return { t: 'literal', v: `\${${fallbackEnvVarName}}` };
        }
        return { t: 'literal', v: `\${${envVarName}}` };
    }

    if (hasImportedMcpInputResolutionIssues(mapping)) {
        const envVarName = toEnvToken(params.inputId);
        params.warnings.push(`${params.draftName}: incomplete saved secret mapping for "${params.inputId}" was mapped to \${${envVarName}}`);
        return { t: 'literal', v: `\${${envVarName}}` };
    }

    const secretId = params.generateId();
    const secretName = createUniqueSavedSecretName({
        base: mapping.secretName.trim(),
        secrets: params.nextSecrets,
    });
    params.nextSecrets.push({
        id: secretId,
        name: secretName,
        kind: mapping.secretKind ?? 'apiKey',
        encryptedValue: { _isSecretValue: true, value: mapping.secretValue.trim() },
        createdAt: params.nowMs,
        updatedAt: params.nowMs,
    });
    return { t: 'savedSecret', secretId };
}

function resolveDraftValueMap(params: Readonly<{
    draftName: string;
    values: Record<string, ImportedMcpDraftValueV1>;
    inputMappings: Record<string, ImportedMcpInputResolutionV1>;
    nextSecrets: SavedSecret[];
    nowMs: number;
    generateId: () => string;
    warnings: string[];
}>): Record<string, McpValueRefV1> {
    const out: Record<string, McpValueRefV1> = {};
    for (const [key, value] of Object.entries(params.values)) {
        out[key] = value.t === 'literal'
            ? value
            : resolveInputValueRef({
                draftName: params.draftName,
                inputId: value.inputId,
                inputMappings: params.inputMappings,
                nextSecrets: params.nextSecrets,
                nowMs: params.nowMs,
                generateId: params.generateId,
                warnings: params.warnings,
            });
    }
    return out;
}

export function materializeImportedMcpServerDrafts(params: Readonly<{
    settings: McpServersSettingsV1;
    secrets: SavedSecret[];
    drafts: ImportedMcpServerDraftV1[];
    inputMappings: Record<string, ImportedMcpInputResolutionV1>;
    defaultMachineId: string;
    nowMs: number;
    generateId: () => string;
}>): MaterializeImportedMcpServerDraftsResult {
    let nextSettings = params.settings;
    const nextSecrets = [...params.secrets];
    const warnings: string[] = [];

    for (const draft of params.drafts) {
        warnings.push(...draft.warnings);
        const entryId = params.generateId();
        const normalizedName = createUniqueMcpServerName({
            base: normalizeMcpServerNameCandidate(draft.name),
            settings: nextSettings,
        });
        const env = resolveDraftValueMap({
            draftName: draft.name,
            values: draft.env,
            inputMappings: params.inputMappings,
            nextSecrets,
            nowMs: params.nowMs,
            generateId: params.generateId,
            warnings,
        });

        const entryBase = {
            id: entryId,
            name: normalizedName,
            title: draft.title?.trim()
                ? draft.title.trim()
                : normalizedName === draft.name
                    ? undefined
                    : draft.name,
            env,
            createdAt: params.nowMs,
            updatedAt: params.nowMs,
        } satisfies Omit<McpServerCatalogEntryV1, 'transport' | 'stdio' | 'remote'>;

        const entry: McpServerCatalogEntryV1 = draft.transport === 'stdio'
            ? {
                ...entryBase,
                transport: 'stdio',
                stdio: {
                    command: draft.stdio?.command ?? '',
                    args: draft.stdio?.args ?? [],
                },
                remote: undefined,
            }
            : {
                ...entryBase,
                transport: draft.transport,
                stdio: undefined,
                remote: {
                    url: draft.remote?.url ?? '',
                    headers: resolveDraftValueMap({
                        draftName: draft.name,
                        values: draft.remote?.headers ?? {},
                        inputMappings: params.inputMappings,
                        nextSecrets,
                        nowMs: params.nowMs,
                        generateId: params.generateId,
                        warnings,
                    }),
                },
            };

        const binding: McpServerBindingV1 = {
            id: params.generateId(),
            serverId: entryId,
            enabled: draft.enabled,
            target: resolveBindingTarget(draft, params.defaultMachineId),
            createdAt: params.nowMs,
            updatedAt: params.nowMs,
        };

        nextSettings = upsertMcpServerWithBindingsV1(nextSettings, entry, [binding]);
    }

    return {
        nextSettings,
        nextSecrets,
        warnings,
    };
}
