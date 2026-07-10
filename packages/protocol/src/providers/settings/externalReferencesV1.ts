import type { ProviderSettingsV1 } from './v1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';

export type ProviderSettingsExternalReferenceDiagnosticV1 = Readonly<{
  path: string;
  reason: 'unknown_machine' | 'unknown_endpoint_template';
}>;

export function validateProviderSettingsExternalReferencesV1(
  settings: ProviderSettingsV1,
  context: Readonly<{
    knownMachineIds: readonly string[];
    endpointTemplateIdsByContributionKey: Readonly<Record<string, readonly string[]>>;
  }>,
): readonly ProviderSettingsExternalReferenceDiagnosticV1[] {
  const diagnostics: ProviderSettingsExternalReferenceDiagnosticV1[] = [];
  const knownMachineIds = new Set(context.knownMachineIds);
  settings.connections.forEach((connection, connectionIndex) => {
    const contributedEndpointIds = connection.source.kind === 'contribution'
      ? readOwnRecordValue(context.endpointTemplateIdsByContributionKey, connection.source.contributionKey)
      : undefined;
    const endpointIds = connection.source.kind === 'custom'
      ? new Set(connection.source.template.endpointTemplates.map((endpoint) => endpoint.id))
      : contributedEndpointIds
        ? new Set(contributedEndpointIds)
        : null;
    const checkOverrides = (
      overrides: readonly Readonly<{ endpointTemplateId: string }>[],
      path: string,
    ) => {
      if (!endpointIds) return;
      overrides.forEach((override, overrideIndex) => {
        if (!endpointIds.has(override.endpointTemplateId)) {
          diagnostics.push({
            path: `${path}[${overrideIndex}].endpointTemplateId`,
            reason: 'unknown_endpoint_template',
          });
        }
      });
    };
    checkOverrides(connection.endpointOverrides ?? [], `connections[${connectionIndex}].endpointOverrides`);
    for (const [machineId, overrides] of Object.entries(connection.endpointOverridesByMachineId ?? {})) {
      const path = `connections[${connectionIndex}].endpointOverridesByMachineId.${machineId}`;
      if (!knownMachineIds.has(machineId)) {
        diagnostics.push({ path, reason: 'unknown_machine' });
        continue;
      }
      checkOverrides(overrides, path);
    }
  });
  settings.machineGrants.forEach((grant, index) => {
    if (!knownMachineIds.has(grant.machineId)) {
      diagnostics.push({ path: `machineGrants[${index}].machineId`, reason: 'unknown_machine' });
    }
  });
  for (const [connectionId, bindings] of Object.entries(settings.secretBindingsByConnectionId)) {
    for (const machineId of Object.keys(bindings.byMachineId ?? {})) {
      if (!knownMachineIds.has(machineId)) {
        diagnostics.push({
          path: `secretBindingsByConnectionId.${connectionId}.byMachineId.${machineId}`,
          reason: 'unknown_machine',
        });
      }
    }
  }
  return diagnostics;
}
