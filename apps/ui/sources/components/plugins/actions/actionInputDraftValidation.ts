import { resolveDeclaredInputLeaves } from '@happier-dev/protocol/plugins/actions/v2';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { embedProtocolJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { InputHints as ActionInputHints } from '@happier-dev/protocol/inputs/inputFields';
import { validateInputFieldValue } from '@happier-dev/protocol/inputs/runtime';
import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';

import type { PluginProjectionAction } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

export function declaredHostInputFieldAdmitsValue(field: ActionInputHints['fields'][number], value: unknown): boolean {
    if (!field.inputType || !('hostType' in field.inputType)) return true;
    const parsed = PluginUiJsonValueV1Schema.safeParse(value);
    return parsed.success && validateInputFieldValue({ field, value: parsed.data }).status === 'valid';
}

export function draftMatchesDeclaredNonSecretFields(params: Readonly<{
    draft: Readonly<Record<string, unknown>>;
    action: Pick<PluginProjectionAction, 'inputHints'>;
    inputSchema: PluginJsonSchemaV2 | undefined;
    /** Only explicitly admitted authoring seeds carry non-presented setup operands. */
    allowDeclaredUnhintedFields?: boolean;
    /** Renderer settlement replaces launch input before complete Action admission. */
    allowUndeclaredFields?: true;
}>): boolean {
    const schema = params.inputSchema;
    const fields = params.action.inputHints?.fields ?? [];
    if (schema === undefined) return fields.length === 0;
    if (fields.length === 0) {
        try {
            return isValidPluginJsonSchemaValue(compilePluginJsonSchema(schema), params.draft);
        } catch {
            return false;
        }
    }
    const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
    // A leaf's local references still belong to the complete Action schema.
    // Relocate both fragments through the protocol owner, including references
    // outside definitions/$defs, rather than compiling a detached leaf.
    const rootPath = ['$defs', 'inputRoot'];
    const referenceRoot = embedProtocolJsonSchema(schema, rootPath);
    const matchesDeclaredValue = (leaves: readonly PluginJsonSchemaV2[], value: unknown): boolean => {
        try {
            return leaves.some(leaf => isValidPluginJsonSchemaValue(compilePluginJsonSchema({
                $defs: { inputRoot: referenceRoot },
                allOf: [embedProtocolJsonSchema(leaf, rootPath)],
            }), value));
        } catch {
            return false;
        }
    };

    const visit = (value: unknown, path: string): boolean => {
        const field = fieldsByPath.get(path);
        if (field) {
            if (field.widget === 'secret' || field.connectedAccountOptions === true) return false;
            if (!declaredHostInputFieldAdmitsValue(field, value)) return false;
            // Conditional hints may live in only one union arm. Reuse the
            // declaration owner's traversal, just as manifest admission does.
            const leaves = resolveDeclaredInputLeaves(schema, path, 'conditional-field');
            return leaves !== null && matchesDeclaredValue(leaves, value);
        }
        // Declared seed operands can be useful without a rendered field hint.
        const hasHintedDescendants = fields.some(candidate => candidate.path.startsWith(`${path}.`));
        const declared = !params.allowDeclaredUnhintedFields || hasHintedDescendants
            ? null : resolveDeclaredInputLeaves(schema, path, 'conditional-field');
        if (declared) return matchesDeclaredValue(declared, value);
        if (params.allowUndeclaredFields && !hasHintedDescendants) return true;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const entries = Object.entries(value as Readonly<Record<string, unknown>>);
        if (entries.length === 0) return false;
        return entries.every(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    };

    return Object.entries(params.draft).every(([key, value]) => visit(value, key));
}
