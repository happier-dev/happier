import { z } from '../../zodRuntimePolicy.js';

import { buildSessionAuthoringFieldArtifacts } from './buildFieldArtifacts.js';
import { SESSION_AUTHORING_CONTEXT_KINDS } from './contextKinds.js';
import {
  SESSION_AUTHORING_FIELD_CATALOG,
  SessionAuthoringExecutionTargetV2Schema,
  SessionAuthoringAutomationV1Schema,
  SyncedSessionAuthoringConnectedServicesV1Schema,
  SyncedSessionAuthoringTerminalV1Schema,
} from './fieldCatalog.js';
import {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from './creationFieldsV1.js';

export type {
  SessionAuthoringContextKind,
} from './contextKinds.js';
export {
  SESSION_AUTHORING_CONTEXT_KINDS,
} from './contextKinds.js';
export type {
  SessionAuthoringFieldDefinition,
  SessionAuthoringFieldDefinitionMap,
  SessionAuthoringDraftStorage,
  SessionAuthoringFieldEditability,
  SessionAuthoringFieldStorageClass,
  SessionAuthoringFieldSurface,
} from './fieldDefinition.js';
export {
  defineSessionAuthoringFields,
} from './fieldDefinition.js';
export type {
  SessionAuthoringFieldArtifacts,
} from './buildFieldArtifacts.js';
export {
  buildSessionAuthoringFieldArtifacts,
} from './buildFieldArtifacts.js';
export {
  SESSION_AUTHORING_FIELD_CATALOG,
  SessionAuthoringExecutionTargetV2Schema,
  SessionAuthoringAutomationV1Schema,
  SyncedSessionAuthoringConnectedServicesV1Schema,
  SyncedSessionAuthoringTerminalV1Schema,
} from './fieldCatalog.js';
export type { SessionAuthoringExecutionTargetV2, TemporaryComputerActivationRefV1 } from './fieldCatalog.js';
export { TemporaryComputerWorkspaceV1Schema } from './temporaryComputerWorkspaceV1.js';
export type { TemporaryComputerWorkspaceV1 } from './temporaryComputerWorkspaceV1.js';
export { TemporaryComputerActivationRefV1Schema } from './fieldCatalog.js';
export {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from './creationFieldsV1.js';

const SESSION_AUTHORING_FIELD_ARTIFACTS = buildSessionAuthoringFieldArtifacts(SESSION_AUTHORING_FIELD_CATALOG);

export const SESSION_AUTHORING_FIELD_IDS = Object.freeze(
  Object.keys(SESSION_AUTHORING_FIELD_ARTIFACTS.definitions),
) as ReadonlyArray<keyof typeof SESSION_AUTHORING_FIELD_CATALOG>;

export type SessionAuthoringFieldId = keyof typeof SESSION_AUTHORING_FIELD_CATALOG;

export const SESSION_AUTHORING_FIELD_DESCRIPTORS = SESSION_AUTHORING_FIELD_ARTIFACTS.definitions;
export const SessionAuthoringValueV1Schema = SESSION_AUTHORING_FIELD_ARTIFACTS.valueSchema;
export const SYNCED_SESSION_AUTHORING_FIELD_IDS_V2 = Object.freeze(
  SESSION_AUTHORING_FIELD_ARTIFACTS.syncedFieldIds,
);
export type SyncedSessionAuthoringFieldIdV2 = (typeof SYNCED_SESSION_AUTHORING_FIELD_IDS_V2)[number];
export const SyncedSessionAuthoringFieldIdV2Schema = z.enum(
  SYNCED_SESSION_AUTHORING_FIELD_IDS_V2 as [SyncedSessionAuthoringFieldIdV2, ...SyncedSessionAuthoringFieldIdV2[]],
);
export const SyncedSessionAuthoringValueV2Schema = SESSION_AUTHORING_FIELD_ARTIFACTS.syncedValueSchema;
export type SyncedSessionAuthoringValueV2 = z.output<typeof SyncedSessionAuthoringValueV2Schema>;

export {
  SYNCED_SESSION_AUTHORING_FIELD_IDS_V1,
  SyncedSessionAuthoringFieldIdV1Schema,
  SyncedSessionAuthoringValueV1Schema,
} from './syncedSessionAuthoringV1.js';
export type {
  SyncedSessionAuthoringFieldIdV1,
  SyncedSessionAuthoringValueV1,
} from './syncedSessionAuthoringV1.js';
export type SessionAuthoringValueV1 = z.output<typeof SessionAuthoringValueV1Schema>;
export type SessionAuthoringAutomationV1 = z.output<typeof SessionAuthoringAutomationV1Schema>;
export type SessionAuthoringCheckoutCreationDraftV1 = z.output<typeof SessionAuthoringCheckoutCreationDraftV1Schema>;
export type SessionAuthoringTerminalV1 = z.output<typeof SessionAuthoringTerminalV1Schema>;

if (SESSION_AUTHORING_CONTEXT_KINDS.length < 1 || SESSION_AUTHORING_FIELD_IDS.length < 1) {
  throw new Error('sessionAuthoring catalogs must not be empty');
}
