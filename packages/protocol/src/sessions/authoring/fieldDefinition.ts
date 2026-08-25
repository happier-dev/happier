import type { input as ZodInput, ZodTypeAny } from 'zod';

import type { SessionAuthoringContextKind } from './contextKinds.js';

export type SessionAuthoringFieldStorageClass = 'template' | 'liveOnly' | 'derived' | 'inheritedOnly';
export type SessionAuthoringDraftStorage = 'sync' | 'composer' | 'exclude';
export type SessionAuthoringFieldEditability = 'editable' | 'inherited' | 'hidden';
export type SessionAuthoringFieldSurface = 'chip' | 'section' | 'chip+section' | 'hidden';

export type SessionAuthoringFieldDefinition<TSchema extends ZodTypeAny = ZodTypeAny> = Readonly<{
  schema: TSchema;
  description: string;
  storageClass: SessionAuthoringFieldStorageClass;
  draftStorage: SessionAuthoringDraftStorage;
  draftSchema?: ZodTypeAny;
  contexts: ReadonlyArray<SessionAuthoringContextKind>;
  defaultSurface: SessionAuthoringFieldSurface;
  requiresLiveSessionData?: boolean;
  defaultEditabilityByContext: Readonly<Partial<Record<SessionAuthoringContextKind, SessionAuthoringFieldEditability>>>;
  default?: ZodInput<TSchema>;
}>;

export type SessionAuthoringFieldDefinitionMap = Readonly<Record<string, SessionAuthoringFieldDefinition<ZodTypeAny>>>;

type SessionAuthoringFieldDefinitionInput<TSchema extends ZodTypeAny = ZodTypeAny> = Readonly<{
  schema: TSchema;
  description: string;
  storageClass: SessionAuthoringFieldStorageClass;
  draftStorage: SessionAuthoringDraftStorage;
  draftSchema?: ZodTypeAny;
  contexts: ReadonlyArray<SessionAuthoringContextKind>;
  defaultSurface: SessionAuthoringFieldSurface;
  requiresLiveSessionData?: boolean;
  defaultEditabilityByContext: Readonly<Partial<Record<SessionAuthoringContextKind, SessionAuthoringFieldEditability>>>;
  default?: ZodInput<TSchema>;
}>;

export function defineSessionAuthoringFields<
  const TDefinitions extends Readonly<Record<string, SessionAuthoringFieldDefinitionInput<ZodTypeAny>>>
>(
  definitions: TDefinitions,
): TDefinitions {
  return definitions;
}
