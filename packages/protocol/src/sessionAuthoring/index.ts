import { buildSessionAuthoringFieldArtifacts } from './buildFieldArtifacts.js';
import { SESSION_AUTHORING_CONTEXT_KINDS } from './contextKinds.js';
import {
  SESSION_AUTHORING_FIELD_CATALOG,
  SessionAuthoringAutomationV1Schema,
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringCodexBackendModeSchema,
  SessionAuthoringTerminalV1Schema,
} from './fieldCatalog.js';

export type {
  SessionAuthoringContextKind,
} from './contextKinds.js';
export {
  SESSION_AUTHORING_CONTEXT_KINDS,
} from './contextKinds.js';
export type {
  SessionAuthoringFieldDefinition,
  SessionAuthoringFieldDefinitionMap,
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
  SessionAuthoringAutomationV1Schema,
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringCodexBackendModeSchema,
  SessionAuthoringTerminalV1Schema,
} from './fieldCatalog.js';

const SESSION_AUTHORING_FIELD_ARTIFACTS = buildSessionAuthoringFieldArtifacts(SESSION_AUTHORING_FIELD_CATALOG);

export const SESSION_AUTHORING_FIELD_IDS = Object.freeze(
  Object.keys(SESSION_AUTHORING_FIELD_ARTIFACTS.definitions),
) as ReadonlyArray<keyof typeof SESSION_AUTHORING_FIELD_CATALOG>;

export type SessionAuthoringFieldId = keyof typeof SESSION_AUTHORING_FIELD_CATALOG;

export const SESSION_AUTHORING_FIELD_DESCRIPTORS = SESSION_AUTHORING_FIELD_ARTIFACTS.definitions;
export const SessionAuthoringValueV1Schema = SESSION_AUTHORING_FIELD_ARTIFACTS.valueSchema;
export type SessionAuthoringValueV1 = typeof SessionAuthoringValueV1Schema['_output'];
export type SessionAuthoringAutomationV1 = typeof SessionAuthoringAutomationV1Schema['_output'];
export type SessionAuthoringCheckoutCreationDraftV1 = typeof SessionAuthoringCheckoutCreationDraftV1Schema['_output'];
export type SessionAuthoringTerminalV1 = typeof SessionAuthoringTerminalV1Schema['_output'];
export type SessionAuthoringCodexBackendMode = typeof SessionAuthoringCodexBackendModeSchema['_output'];

if (SESSION_AUTHORING_CONTEXT_KINDS.length < 1 || SESSION_AUTHORING_FIELD_IDS.length < 1) {
  throw new Error('sessionAuthoring catalogs must not be empty');
}
