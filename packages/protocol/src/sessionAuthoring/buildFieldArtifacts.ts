import { z, type output as ZodOutput, type ZodTypeAny } from 'zod';

import type { SessionAuthoringFieldDefinitionMap } from './fieldDefinition.js';

type SessionAuthoringFieldShape<TDefinitions extends SessionAuthoringFieldDefinitionMap> = {
  [TKey in keyof TDefinitions]: TDefinitions[TKey]['schema'];
};

type SessionAuthoringFieldDefaults<TDefinitions extends SessionAuthoringFieldDefinitionMap> = Partial<{
  [TKey in keyof TDefinitions]: ZodOutput<TDefinitions[TKey]['schema']>;
}>;

export type SessionAuthoringFieldArtifacts<TDefinitions extends SessionAuthoringFieldDefinitionMap> = Readonly<{
  definitions: TDefinitions;
  shape: SessionAuthoringFieldShape<TDefinitions>;
  valueSchema: z.ZodObject<SessionAuthoringFieldShape<TDefinitions>>;
  defaults: SessionAuthoringFieldDefaults<TDefinitions>;
}>;

function parseFieldDefault<TDefinition extends SessionAuthoringFieldDefinitionMap[string]>(
  key: string,
  definition: TDefinition,
): ZodOutput<TDefinition['schema']> | undefined {
  if (definition.default === undefined) {
    return undefined;
  }

  const parsed = definition.schema.safeParse(definition.default);
  if (!parsed.success) {
    throw new Error(`Invalid default for session authoring field "${key}"`);
  }
  return parsed.data as ZodOutput<TDefinition['schema']>;
}

export function buildSessionAuthoringFieldArtifacts<TDefinitions extends SessionAuthoringFieldDefinitionMap>(
  definitions: TDefinitions,
): SessionAuthoringFieldArtifacts<TDefinitions> {
  const shape = {} as SessionAuthoringFieldShape<TDefinitions>;
  const defaults = {} as SessionAuthoringFieldDefaults<TDefinitions>;

  for (const key of Object.keys(definitions) as Array<keyof TDefinitions>) {
    const definition = definitions[key];
    shape[key] = definition.schema;
    const parsedDefault = parseFieldDefault(String(key), definition);
    if (parsedDefault !== undefined) {
      defaults[key] = parsedDefault;
    }
  }

  return {
    definitions,
    shape,
    valueSchema: z.object(shape).strict() as z.ZodObject<SessionAuthoringFieldShape<TDefinitions>>,
    defaults,
  };
}
