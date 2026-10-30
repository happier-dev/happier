import { PluginIdSchema } from '../../pluginId.js';
import { PluginJsonSchemaV2Schema } from '../jsonSchema.js';
import { PluginSettingsContributionV2Schema, type PluginSettingFieldV2, type PluginSettingsContributionV2 } from '../settings.js';
import { cloneStrictPluginJsonValue } from '../../actions/protocolComposableSchema.js';
import { resolvePluginLocalizedStringV2Text, type PluginJsonValueV2 } from '../publicTypes.js';
import type { PluginDeclarativeProjectedSettingsFieldV1 } from './declarativeProjectedModelV1.js';

export class PluginUiDeclarationProjectionErrorV1 extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}
export type StablePluginSettingsIdentity = Readonly<{
    pluginId: string;
    qualifiedId: string;
}>;
export type PluginUiSettingsFieldDescriptorV1 = Omit<PluginDeclarativeProjectedSettingsFieldV1['descriptor'], 'secret' | 'default'> & (
    Readonly<{ secret?: false; default?: PluginJsonValueV2 }> | Readonly<{ secret: true; default?: never }>
);
export type StablePluginSettingsField = Omit<PluginDeclarativeProjectedSettingsFieldV1, 'descriptor'> & Readonly<{
    descriptor: PluginUiSettingsFieldDescriptorV1;
}>;
export type StablePluginSettingsScope = PluginSettingsContributionV2['scope'];
export type StablePluginSettingsModel = Readonly<{
    identity: StablePluginSettingsIdentity;
    scope: StablePluginSettingsScope;
    descriptors: readonly PluginUiSettingsFieldDescriptorV1[];
    fields: readonly StablePluginSettingsField[];
}>;
function projectionError(code: string, message: string): PluginUiDeclarationProjectionErrorV1 {
    return new PluginUiDeclarationProjectionErrorV1(code, message);
}
function clonePlainData<T>(value: T, path = 'value'): T {
    try {
        return cloneStrictPluginJsonValue(value, path) as T;
    } catch (error) {
        throw projectionError('plugin_settings_invalid_plain_data', error instanceof Error ? error.message : path);
    }
}

function localizedText(value: string | Readonly<{ key: string; fallback: string }>): string {
    return resolvePluginLocalizedStringV2Text(value);
}

function normalizeTarget(
    pluginId: string,
    target: PluginSettingsContributionV2['target'],
): PluginDeclarativeProjectedSettingsFieldV1['descriptor']['target'] {
    if (target.kind === 'plugin') return Object.freeze({ kind: 'plugin' });
    const agent = typeof target.agent === 'string'
        ? { pluginId, localId: target.agent }
        : target.agent;
    return Object.freeze({
        kind: 'agent',
        agent: Object.freeze({ pluginId: agent.pluginId, localId: agent.localId }),
    });
}

function descriptorForField(
    contribution: PluginSettingsContributionV2,
    field: PluginSettingFieldV2,
    pluginId: string,
): PluginUiSettingsFieldDescriptorV1 {
    const schema = PluginJsonSchemaV2Schema.parse(clonePlainData(field.schema));
    const base = {
        id: field.id,
        title: localizedText(field.title),
        ...(field.description ? { description: localizedText(field.description) } : {}),
        target: normalizeTarget(pluginId, contribution.target),
        scope: contribution.scope,
        schema,
    };
    return isSecretSettingField(field)
        ? Object.freeze({ ...base, secret: true as const })
        : Object.freeze({
            ...base,
            ...(field.default === undefined ? {} : { default: clonePlainData(field.default) }),
        });
}

function isSecretSettingField(field: PluginSettingFieldV2): boolean {
    return field.secret === true || (field.secret !== undefined && field.secret !== false);
}

function qualifiedSettingsId(pluginId: string, scope: StablePluginSettingsScope): string {
    return `${pluginId}/settings/${scope}`;
}

function qualifiedSettingsFieldId(identity: StablePluginSettingsIdentity, contributionId: string, fieldId: string): string {
    return `${identity.qualifiedId}/${encodeURIComponent(contributionId)}/fields/${encodeURIComponent(fieldId)}`;
}

export function createStablePluginSettingsModel(params: Readonly<{
    pluginId: string;
    contribution?: PluginSettingsContributionV2;
    contributions?: readonly PluginSettingsContributionV2[];
}>): StablePluginSettingsModel {
    const pluginId = PluginIdSchema.parse(params.pluginId);
    if ((params.contribution === undefined) === (params.contributions === undefined)) {
        throw projectionError(
            'plugin_settings_declaration_invalid',
            `Plugin settings declarations for '${pluginId}' are invalid`,
        );
    }
    const inputContributions = params.contributions ?? [params.contribution!];
    if (inputContributions.length === 0) {
        throw projectionError('plugin_settings_declaration_invalid', `Plugin settings declarations for '${pluginId}' are empty`);
    }
    const contributions = inputContributions.map((input, index) => {
        const plainContribution = clonePlainData(input, `contributions[${index}]`);
        if (!PluginSettingsContributionV2Schema.safeParse(plainContribution).success) {
            throw projectionError(
                'plugin_settings_declaration_invalid',
                `Plugin settings declaration for '${pluginId}' is invalid`,
            );
        }
        // Keep the accessor-free clone rather than Zod's reconstructed objects so JSON keys such
        // as `__proto__` retain exact own-property semantics after validation.
        return plainContribution;
    });
    const scope = contributions[0]!.scope;
    if (contributions.some((contribution) => contribution.scope !== scope)) {
        throw projectionError(
            'plugin_settings_scope_mixed',
            `Plugin settings declarations for '${pluginId}' span multiple persistence scopes`,
        );
    }
    const identity = Object.freeze({
        pluginId,
        qualifiedId: qualifiedSettingsId(pluginId, scope),
    });
    const fieldIds = new Set<string>();
    const fields = contributions.flatMap((contribution) => contribution.fields.map((field): StablePluginSettingsField => {
        const qualifiedId = qualifiedSettingsFieldId(identity, contribution.id, field.id);
        if (fieldIds.has(field.id)) {
            throw projectionError(
                'plugin_settings_field_id_conflict',
                `Plugin setting '${field.id}' is declared by multiple settings contributions for '${pluginId}'`,
            );
        }
        fieldIds.add(field.id);
        return Object.freeze({
            id: field.id,
            contributionId: contribution.id,
            qualifiedId,
            descriptor: descriptorForField(contribution, field, pluginId),
        });
    }));
    const model: StablePluginSettingsModel = Object.freeze({
        identity,
        scope,
        descriptors: Object.freeze(fields.map((field) => field.descriptor)),
        fields: Object.freeze(fields),
    });
    return model;
}

/**
 * Builds one independent model per natural Settings scope.  This is the
 * canonical partition point: callers cannot flatten Account and daemon
 * values into one revision, record, or watch stream.
 */
export function createStablePluginSettingsModels(params: Readonly<{
    pluginId: string;
    contributions: readonly PluginSettingsContributionV2[];
}>): ReadonlyMap<StablePluginSettingsScope, StablePluginSettingsModel> {
    const pluginId = PluginIdSchema.parse(params.pluginId);
    const byScope = new Map<StablePluginSettingsScope, PluginSettingsContributionV2[]>();

    for (const contribution of params.contributions) {
        const group = byScope.get(contribution.scope) ?? [];
        group.push(contribution);
        byScope.set(contribution.scope, group);
    }

    return new Map(
        [...byScope.entries()].map(([scope, contributions]) => [
            scope,
            createStablePluginSettingsModel({ pluginId, contributions }),
        ]),
    );
}
