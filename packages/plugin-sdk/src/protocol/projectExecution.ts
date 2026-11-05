import { WorkspaceAddressV1ProtocolSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SecretReferenceOverlayV1ProtocolSchema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import {
    WorkspaceExecutionConfigAddressV1ProtocolSchema,
    WorkspaceWorkerPreferenceMutationResultV1ProtocolSchema,
    WorkspaceWorkerPreferenceReadResultV1ProtocolSchema,
} from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { WorkspaceWorkerPreferenceSetInputV1ProtocolSchema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectDefinitionInspectOutputProtocolSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectComputeExecResultV1ProtocolSchema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionOperationAddressV1ProtocolSchema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { ActionOperationGetV1ResponseProtocolSchema as canonicalOperationResponse, type ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { PluginUiActionOperationHostReadResultV1ProtocolSchema as canonicalOperationHostRead, type PluginUiActionOperationHostReadResultV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
export type { ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
export type { ProjectSetupConsentRequiredV1 } from '@happier-dev/protocol/actions/projectActionFamily';
export type { PluginUiActionOperationHostReadResultV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';

import type { PluginActionInputById, PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from './protocolFacade.js';

/** Accepted source checkout identity; it does not select a worker copy. */
export const ProtocolWorkspaceAddressV1Schema: ProtocolComposableSchema<PluginActionInputById['projects.compute.exec']['workspace']> = WorkspaceAddressV1ProtocolSchema;
/** The output owner's exact qualified Project operation address. */
export const ProjectExecutionOperationRefV1ProtocolSchema: ProtocolComposableSchema<PluginActionInputById['projects.execution.output.open']> = ActionOperationAddressV1ProtocolSchema;
/** Metadata observation keeps source-workspace evidence distinct from worker custody. */
export const ActionOperationGetV1ResponseProtocolSchema: ProtocolComposableSchema<ActionOperationGetV1Response> = canonicalOperationResponse;
/** The mounted Resource preserves current owner transport observation beside its exact operation. */
export const PluginUiActionOperationHostReadResultV1ProtocolSchema: ProtocolComposableSchema<PluginUiActionOperationHostReadResultV1> = canonicalOperationHostRead;
/** Saved Secret references only; the Project materializer retains value custody. */
export const ProtocolSecretReferenceOverlayV1Schema: ProtocolComposableSchema<NonNullable<PluginActionInputById['projects.compute.exec']['environmentBindings']>> = SecretReferenceOverlayV1ProtocolSchema;
export const ProtocolWorkspaceExecutionConfigAddressV1Schema: ProtocolComposableSchema<PluginActionInputById['projects.worker.preferences.get']['workspace']> = WorkspaceExecutionConfigAddressV1ProtocolSchema;
export const ProtocolWorkspaceWorkerPreferenceSetInputV1Schema: ProtocolComposableSchema<PluginActionInputById['projects.worker.preferences.set']> = WorkspaceWorkerPreferenceSetInputV1ProtocolSchema;
export const ProtocolWorkspaceWorkerPreferenceReadResultV1Schema: ProtocolComposableSchema<PluginActionResultById['projects.worker.preferences.get']> = WorkspaceWorkerPreferenceReadResultV1ProtocolSchema;
export const ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema: ProtocolComposableSchema<PluginActionResultById['projects.worker.preferences.set']> = WorkspaceWorkerPreferenceMutationResultV1ProtocolSchema;
export const ProtocolProjectDefinitionInspectOutputSchema: ProtocolComposableSchema<PluginActionResultById['projects.inspect']> = ProjectDefinitionInspectOutputProtocolSchema;
/** A setup hold and an accepted operation retain their distinct canonical arms. */
export const ProtocolProjectComputeExecResultV1Schema: ProtocolComposableSchema<
    PluginActionResultById['projects.compute.exec'],
    PluginActionResultById['projects.compute.exec'] & ProtocolJsonValue
> = ProjectComputeExecResultV1ProtocolSchema;
