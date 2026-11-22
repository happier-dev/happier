import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { parseQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { ProviderManagedUnavailableConnectedAccountPurposeV1Schema, resolveProviderManagedRuntimeFromContributionV1 } from './contributions/v1.js';
import { projectProviderManagedConnectedAccountPurposeV1 } from './connections/sourceFactsV1.js';
import { areProviderContributionKeysEqualV1 } from './contributionIdentityV1.js';
import { ProviderContributionKeySchema, ProviderMachineIdSchema } from './ids.js';
import type { AccountProviderDeclarationV1 } from './catalog/accountModelProjectionV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposeIdentity.js';

export const ProviderGatewayContributionV1Schema = lazyZodSchema(() => z.strictObject({
    contributionKey: ProviderContributionKeySchema.check(z.refine(value => parseQualifiedPluginContributionKey(value) !== null)),
    purposes: z.array(z.strictObject({ purpose: QualifiedConnectedAccountPurposeV1Schema.shape.purpose, service: asProtocolZod(PluginContributionIdentityV1Schema) })),
}));
export type ProviderGatewayContributionV1 = z.infer<typeof ProviderGatewayContributionV1Schema>;

/** The existing gateway setup flow configures managed Provider connections. */
export function readProviderGatewayContributionPurposesV1(contributionKey: string, declarations: readonly AccountProviderDeclarationV1[]) {
    const declaration = declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, contributionKey));
    const identity = parseQualifiedPluginContributionKey(contributionKey);
    if (!declaration || !identity) return null;
    if (!declaration.definition.managedRuntime) return [];
    return resolveProviderManagedRuntimeFromContributionV1({ implementationIdentity: identity,
        definition: { ...declaration.definition, managedRuntime: declaration.definition.managedRuntime } }).connectedAccounts
        .map(projectProviderManagedConnectedAccountPurposeV1);
}

export type ProviderGatewayFamilyAvailabilityV1 =
    | (NonNullable<ReturnType<typeof readProviderGatewayContributionPurposesV1>>[number] & Readonly<{ status: 'available' }>)
    | (NonNullable<ReturnType<typeof resolveProviderManagedRuntimeFromContributionV1>['unavailableConnectedAccounts']>[number] & Readonly<{ status: 'unavailable' }>);

/** Passive family presentation never expands selectable or executable purposes. */
export function readProviderGatewayFamilyAvailabilityV1(contributionKey: string,
    declarations: readonly AccountProviderDeclarationV1[],
): readonly ProviderGatewayFamilyAvailabilityV1[] | null {
    const declaration = declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, contributionKey));
    const identity = parseQualifiedPluginContributionKey(contributionKey);
    if (!declaration || !identity) return null;
    if (!declaration.definition.managedRuntime) return [];
    const managedRuntime = resolveProviderManagedRuntimeFromContributionV1({ implementationIdentity: identity,
        definition: { ...declaration.definition, managedRuntime: declaration.definition.managedRuntime } });
    return [
        ...managedRuntime.connectedAccounts.map(purpose => ({ ...projectProviderManagedConnectedAccountPurposeV1(purpose), status: 'available' as const })),
        ...(managedRuntime.unavailableConnectedAccounts ?? []).map(purpose => ({ ...purpose, status: 'unavailable' as const })),
    ];
}

/** Descriptor-only enumeration: no saved-connection read or runtime activation. */
export function listProviderGatewayContributionsV1(declarations: readonly AccountProviderDeclarationV1[]): ProviderGatewayContributionV1[] {
    return declarations.flatMap(declaration => {
        const purposes = readProviderGatewayContributionPurposesV1(declaration.contributionKey, [declaration]) ?? [];
        return purposes.length ? [{ contributionKey: declaration.contributionKey, purposes: purposes.map(({ purpose, service }) => ({ purpose, service })) }] : [];
    });
}

export const ProviderGatewayChoiceInputV1Schema = lazyZodSchema(() => z.strictObject({
    contributionKey: z.optional(ProviderGatewayContributionV1Schema.shape.contributionKey),
    machineId: z.optional(ProviderMachineIdSchema),
    service: z.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
    purpose: z.optional(QualifiedConnectedAccountPurposeV1Schema.shape.purpose),
}));
export const ProviderGatewayChoiceResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('selected'), contribution: ProviderGatewayContributionV1Schema }),
    z.strictObject({ status: z.literal('choice_required'), choices: z.array(ProviderGatewayContributionV1Schema) }),
    z.strictObject({ status: z.literal('unavailable'), choices: z.array(ProviderGatewayContributionV1Schema),
        unavailableFamilies: z.optional(z.array(z.strictObject({
            ...ProviderManagedUnavailableConnectedAccountPurposeV1Schema.shape,
            contributionKey: ProviderGatewayContributionV1Schema.shape.contributionKey,
            service: asProtocolZod(PluginContributionIdentityV1Schema),
        }))),
    }),
]));
export type ProviderGatewayChoiceResultV1 = z.infer<typeof ProviderGatewayChoiceResultV1Schema>;

export function chooseProviderGatewayContributionV1(
    declarations: readonly AccountProviderDeclarationV1[], input: z.infer<typeof ProviderGatewayChoiceInputV1Schema>,
): ProviderGatewayChoiceResultV1 {
    const choices = listProviderGatewayContributionsV1(declarations).filter(candidate => candidate.purposes.some(slot => (
        (!input.service || slot.service.pluginId === input.service.pluginId && slot.service.localId === input.service.localId)
        && (!input.purpose || slot.purpose === input.purpose)
    )));
    const unavailable = (): ProviderGatewayChoiceResultV1 => {
        const unavailableFamilies = declarations.flatMap(declaration => {
            if (input.contributionKey && !areProviderContributionKeysEqualV1(declaration.contributionKey, input.contributionKey)) return [];
            return (readProviderGatewayFamilyAvailabilityV1(declaration.contributionKey, [declaration]) ?? [])
                .filter((family): family is Extract<ProviderGatewayFamilyAvailabilityV1, { status: 'unavailable' }> => family.status === 'unavailable'
                    && (!input.service || family.service.pluginId === input.service.pluginId && family.service.localId === input.service.localId)
                    && (!input.purpose || family.purpose === input.purpose))
                .map(({ status: _status, ...family }) => ({ contributionKey: declaration.contributionKey, ...family }));
        });
        return { status: 'unavailable', choices, ...(unavailableFamilies.length ? { unavailableFamilies } : {}) };
    };
    if (input.contributionKey) {
        const contribution = choices.find(candidate => areProviderContributionKeysEqualV1(candidate.contributionKey, input.contributionKey!));
        return contribution ? { status: 'selected', contribution } : unavailable();
    }
    if (choices.length === 1) return { status: 'selected', contribution: choices[0]! };
    return choices.length ? { status: 'choice_required', choices } : unavailable();
}
