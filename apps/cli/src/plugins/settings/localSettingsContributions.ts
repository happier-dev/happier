import {
    PluginSettingsContributionV2Schema,
    type PluginSettingFieldV2,
    type PluginSettingsContributionV2,
} from '@happier-dev/protocol';

import type { ResolvedSettingsContribution } from '@/plugins/projection/registry/types';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol';
import {
    evaluateContributionAvailability,
    type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

import {
    compilePluginSettingFieldSchema,
    PluginSettingFieldSchemaCompilationError,
} from './fieldSchemaValidation';

export class PluginLocalSettingsDeclarationError extends Error {
    readonly code:
        | 'PLUGIN_SETTINGS_DECLARATION_INVALID'
        | 'PLUGIN_SETTINGS_PLUGIN_ID_REQUIRED'
        | 'PLUGIN_SETTINGS_SCHEMA_INVALID'
        | 'PLUGIN_SETTINGS_DEFAULT_INVALID'
        | 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE'
        | 'PLUGIN_SETTINGS_AVAILABILITY_UNAVAILABLE';
    readonly pluginId: string;
    readonly contributionId: string;
    readonly fieldId?: string;
    readonly policyCode?: string;
    readonly reason: string;

    constructor(params: Readonly<{
        code: PluginLocalSettingsDeclarationError['code'];
        pluginId: string;
        contributionId: string;
        fieldId?: string;
        policyCode?: string;
        reason: string;
    }>) {
        super(params.reason);
        this.name = 'PluginLocalSettingsDeclarationError';
        this.code = params.code;
        this.pluginId = params.pluginId;
        this.contributionId = params.contributionId;
        this.fieldId = params.fieldId;
        this.policyCode = params.policyCode;
        this.reason = params.reason;
    }
}

export type ResolvedLocalSettingsDeclaration = Readonly<{
    pluginId: string;
    definition: PluginSettingsContributionV2;
}>;

export function resolveLocalSettingsDeclarations(params: Readonly<{
    settings: readonly ResolvedSettingsContribution[];
    pluginId?: string;
}>): readonly ResolvedLocalSettingsDeclaration[] {
    const declarations: ResolvedLocalSettingsDeclaration[] = [];

    for (const contribution of params.settings) {
        if (!contribution.pluginId) {
            throw new PluginLocalSettingsDeclarationError({
                code: 'PLUGIN_SETTINGS_PLUGIN_ID_REQUIRED',
                pluginId: '<missing>',
                contributionId: contribution.definition.id,
                reason: `Plugin settings contribution '${contribution.definition.id}' has no plugin owner`,
            });
        }
        if (params.pluginId && contribution.pluginId !== params.pluginId) continue;
        const parsed = PluginSettingsContributionV2Schema.safeParse(contribution.definition);
        if (!parsed.success) {
            const firstIssue = parsed.error.issues[0];
            const reason = firstIssue
                ? `${firstIssue.path.join('.') || '<root>'}: ${firstIssue.message}`
                : 'definition does not match the canonical Manifest V2 settings contract';
            throw new PluginLocalSettingsDeclarationError({
                code: 'PLUGIN_SETTINGS_DECLARATION_INVALID',
                pluginId: contribution.pluginId,
                contributionId: contribution.definition.id,
                reason,
            });
        }
        const definition = parsed.data;
        for (const field of definition.fields) {
            let validate: ReturnType<typeof compilePluginSettingFieldSchema>;
            try {
                validate = compilePluginSettingFieldSchema(field);
            } catch (error) {
                if (!(error instanceof PluginSettingFieldSchemaCompilationError)) throw error;
                throw new PluginLocalSettingsDeclarationError({
                    code: 'PLUGIN_SETTINGS_SCHEMA_INVALID',
                    pluginId: contribution.pluginId,
                    contributionId: definition.id,
                    fieldId: field.id,
                    reason: `Plugin setting '${field.id}' has an invalid schema`,
                });
            }
            if (field.secret === undefined && field.default !== undefined && !isValidPluginJsonSchemaValue(validate, field.default)) {
                throw new PluginLocalSettingsDeclarationError({
                    code: 'PLUGIN_SETTINGS_DEFAULT_INVALID',
                    pluginId: contribution.pluginId,
                    contributionId: definition.id,
                    fieldId: field.id,
                    reason: `Plugin setting '${field.id}' has an invalid default`,
                });
            }
        }
        declarations.push(Object.freeze({ pluginId: contribution.pluginId, definition }));
    }

    return Object.freeze(declarations);
}

export function flattenLocalSettingsFields(
    declarations: readonly ResolvedLocalSettingsDeclaration[],
): readonly PluginSettingFieldV2[] {
    return Object.freeze(declarations.flatMap((declaration) => declaration.definition.fields));
}

export function assertLocalSettingsDeclarationsAccessible(params: Readonly<{
    declarations: readonly ResolvedLocalSettingsDeclaration[];
    facts: ContributionPolicyFacts;
    supportedScopes: ReadonlySet<PluginSettingsContributionV2['scope']>;
}>): void {
    for (const declaration of params.declarations) {
        if (!params.supportedScopes.has(declaration.definition.scope)) {
            throw new PluginLocalSettingsDeclarationError({
                code: 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
                pluginId: declaration.pluginId,
                contributionId: declaration.definition.id,
                reason: `Plugin settings scope '${declaration.definition.scope}' has no bound runtime persistence owner`,
            });
        }
        for (const field of declaration.definition.fields) {
            const decision = evaluateContributionAvailability({
                availability: field.availability,
                facts: params.facts,
            });
            if (decision.outcome === 'visible') continue;
            throw new PluginLocalSettingsDeclarationError({
                code: 'PLUGIN_SETTINGS_AVAILABILITY_UNAVAILABLE',
                pluginId: declaration.pluginId,
                contributionId: declaration.definition.id,
                fieldId: field.id,
                policyCode: decision.code,
                reason: `Plugin setting '${field.id}' is unavailable by canonical contribution policy`,
            });
        }
    }
}
