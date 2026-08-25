import {
    PluginEventAutomationSetupResultV1Schema,
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type PluginEventAutomationSetupResultV1,
} from '@happier-dev/protocol';

export type PluginEventAutomationSetupResultValidation =
    | Readonly<{ kind: 'available'; result: PluginEventAutomationSetupResultV1 }>
    | Readonly<{ kind: 'invalid' }>;

/**
 * Revalidates a setup Action's JSON result against the exact selected Event
 * declaration immediately before the incumbent Automation writer consumes
 * source facts. The cold catalog owns the declaration; this adapter owns no
 * Event discovery, Action selection, or persisted setup state.
 */
export function validatePluginEventAutomationSetupResult(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    result: unknown;
}>): PluginEventAutomationSetupResultValidation {
    const result = PluginEventAutomationSetupResultV1Schema.safeParse(params.result);
    if (!result.success) return { kind: 'invalid' };

    const source = params.eligibleEvent.event.automation.source;
    if (result.data.sourceContractVersion !== source.sourceContractVersion) {
        return { kind: 'invalid' };
    }

    try {
        return isValidPluginJsonSchemaValue(
            compilePluginJsonSchema(source.sourceConfigSchema),
            result.data.sourceConfig,
        )
            ? { kind: 'available', result: result.data }
            : { kind: 'invalid' };
    } catch {
        // The daemon admission/schema parser should make this unreachable,
        // but a UI consumer still fails closed if the projection is malformed.
        return { kind: 'invalid' };
    }
}
