import type { ManagedMachinePresetCreationV1, ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { managedPresetMachineName, type ManagedDeclaration } from './managedRows';

/** Saved choices establish no native option or prerequisite observation. */
export function buildManagedPresetSavedReview(preset: ManagedMachinePresetV1 & ManagedMachinePresetCreationV1,
    declaration: ManagedDeclaration, controller?: ManagedControllerV1): ManagedConfigurationFactsV1 {
    const { credentials: _credentials, ...stored } = preset.launch;
    const launch = { ...stored, name: managedPresetMachineName(declaration.provisioner) };
    return buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(declaration.launchSchema),
        launch, ...(controller ? { controller } : {}), provisioner: declaration.provisioner,
        optionStatus: 'unavailable', prerequisites: declaration.provisioner.prerequisites.map(requirement => ({ requirement, status: 'unknown' as const })),
        billing: declaration.billing, retentionCapabilities: declaration.retention,
        preset: { id: preset.id, revision: preset.revision, name: preset.name,
            retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage }, setup: preset.setup });
}
