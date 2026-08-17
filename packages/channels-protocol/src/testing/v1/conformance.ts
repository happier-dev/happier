import {
    parsePluginManifest,
    type ParsedPluginManifest,
} from '@happier-dev/plugin-sdk/manifest';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationProvidersContributionPointV1,
    ConversationProvidersContributionProtocolV1,
} from '../../v1/provider/contribution.js';

/** The canonical parsed action fields relevant to a Channels provider binding. */
export type ConversationProviderActionDeclarationV1 = Readonly<{
    id: string;
    inputSchema?: unknown;
    resultSchema?: unknown;
    surfaces: readonly string[];
    dangerLevel: string;
}>;

/** The canonical parsed contribution fields relevant to Channels V1. */
export type ConversationProviderContributionV1 = Readonly<{
    target: Readonly<{
        pluginId: string;
        pointId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: unknown;
    operations: Readonly<Record<string, string>>;
    surfaces?: unknown;
}>;

type ConversationProviderContributesV1 = Readonly<{
    actions: readonly ConversationProviderActionDeclarationV1[];
    targetedPluginContributions: readonly ConversationProviderContributionV1[];
}>;

/** The parsed provider contribution selected by the Channels V1 source-level check. */
export type ConversationProviderContributionConformanceV1 = Readonly<{
    manifest: ParsedPluginManifest;
    contribution: ConversationProviderContributionV1;
}>;

/** The non-runtime result of checking one external provider manifest against Channels V1. */
export type ConversationProviderContributionConformanceResultV1 =
    | Readonly<{
        ok: true;
        value: ConversationProviderContributionConformanceV1;
    }>
    | Readonly<{
        ok: false;
        errors: readonly string[];
    }>;

const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const CHANNELS_PROVIDER_POINT_ID = 'providers';
const providerOperations = ConversationProvidersContributionProtocolV1.operations;
const expectedRoleDefinitions = ConversationProvidersContributionPointV1.protocols[0]!.operations;

function includesRequiredStrings(
    actual: readonly string[],
    required: readonly string[],
): boolean {
    return required.every((value) => actual.includes(value));
}

/**
 * Checks the source-level declaration for exactly one Channels provider.
 *
 * The canonical SDK parser owns manifest structure. This helper only composes
 * that parsed declaration with the public Channels V1 role contract; host
 * installation, generation currentness, and runtime admission remain host-owned.
 */
export function checkConversationProviderContributionV1(
    manifestInput: unknown,
): ConversationProviderContributionConformanceResultV1 {
    const parsed = parsePluginManifest(manifestInput);
    if (!parsed.ok) {
        return Object.freeze({
            ok: false,
            errors: Object.freeze(parsed.diagnostics.map((diagnostic) => (
                `${diagnostic.path?.join('.') || 'manifest'}: ${diagnostic.message}`
            ))),
        });
    }
    const parsedManifest = parsed.manifest;
    // The public SDK parser is the structural authority. Its declaration-safe
    // projection names the generic envelope facts this feature conformance
    // reader consumes without importing a private Protocol parser.
    const contributes: ConversationProviderContributesV1 = parsedManifest.contributes;

    const contributions = contributes.targetedPluginContributions.filter((contribution) => (
        contribution.target.pluginId === CHANNELS_CORE_PLUGIN_ID
        && contribution.target.pointId === CHANNELS_PROVIDER_POINT_ID
    ));
    if (contributions.length !== 1) {
        return Object.freeze({
            ok: false,
            errors: Object.freeze([
                `Channels V1 requires exactly one '${CHANNELS_CORE_PLUGIN_ID}/${CHANNELS_PROVIDER_POINT_ID}' contribution; found ${contributions.length}.`,
            ]),
        });
    }

    const contribution = contributions[0]!;
    const errors: string[] = [];
    const protocol = ConversationProvidersContributionProtocolV1;
    if (
        contribution.protocol.id !== protocol.id
        || contribution.protocol.version !== protocol.version
    ) {
        errors.push(
            `Channels provider contribution must declare protocol '${protocol.id}' version ${protocol.version}.`,
        );
    }
    if (contribution.descriptor !== undefined) {
        errors.push('Channels V1 provider contributions do not declare a descriptor.');
    }
    if (contribution.surfaces !== undefined) {
        errors.push('Channels V1 provider contributions do not declare renderer surfaces.');
    }

    const actionsById = new Map(contributes.actions.map((action) => [action.id, action]));
    const expectedRoles = Object.keys(providerOperations) as Array<keyof typeof providerOperations>;
    for (const role of Object.keys(contribution.operations)) {
        if (!Object.hasOwn(providerOperations, role)) {
            errors.push(`Channels V1 does not define provider role '${role}'.`);
        }
    }

    for (const role of expectedRoles) {
        const roleDefinition = expectedRoleDefinitions[role]!;
        const operation = providerOperations[role];
        const actionId = contribution.operations[role];
        if (roleDefinition.required && actionId === undefined) {
            errors.push(`Channels V1 requires the '${role}' provider role binding.`);
            continue;
        }
        if (actionId === undefined) continue;

        const action = actionsById.get(actionId);
        if (!action) {
            errors.push(`Channels provider role '${role}' references undeclared Action '${actionId}'.`);
            continue;
        }
        if (!includesRequiredStrings(action.surfaces, operation.declaration.surfaces)) {
            errors.push(`Channels provider role '${role}' Action '${actionId}' has an incompatible surface.`);
        }
        if (action.dangerLevel !== operation.declaration.dangerLevel) {
            errors.push(`Channels provider role '${role}' Action '${actionId}' has an incompatible danger level.`);
        }
        if (!pluginJsonValuesEqual(action.resultSchema, operation.declaration.resultSchema.jsonSchema)) {
            errors.push(`Channels provider role '${role}' Action '${actionId}' has an incompatible result schema.`);
        }
        if (operation.declaration.input.kind === 'contributorDefined') {
            if (action.inputSchema === undefined) {
                errors.push(`Channels provider role '${role}' Action '${actionId}' must declare its contributor-defined input schema.`);
            }
        } else if (!pluginJsonValuesEqual(action.inputSchema, operation.declaration.input.schema.jsonSchema)) {
            errors.push(`Channels provider role '${role}' Action '${actionId}' has an incompatible input schema.`);
        }
    }

    return errors.length === 0
        ? Object.freeze({
            ok: true,
            value: Object.freeze({
                manifest: parsedManifest,
                contribution,
            }),
        })
        : Object.freeze({ ok: false, errors: Object.freeze(errors) });
}
