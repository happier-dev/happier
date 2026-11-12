import type { ActionInputHints, PluginActionContributionV2 } from '@happier-dev/protocol';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { defineDerivedDeclarationField, forwardDeclarationField, readPrecomputedDeclarationField } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';
import type { ResolvedActionLocalizedPresentation } from '../types';

/** The input facet shared by full Action normalization and admitted listings. */
export function projectPluginActionInputDefinition(definition: PluginActionContributionV2): Readonly<{
  id: string;
  inputSchema?: PluginActionContributionV2['inputSchema'];
  inputHints: ActionInputHints | null;
}> {
  const projected: Record<string, unknown> = { id: definition.id };
  // A bundled schema may be deferred; forward it and derive its hints on first read.
  forwardDeclarationField(projected, 'inputSchema', definition);
  // Bundled summaries carry the publisher-derived hints, so forms never read the schema.
  const precomputed = readPrecomputedDeclarationField(definition, 'inputHints');
  if (precomputed) projected.inputHints = precomputed.value;
  else defineDerivedDeclarationField(projected, 'inputHints', [[definition, 'inputSchema']],
    () => normalizePluginActionInputHintsV2(definition.inputHints, definition.inputSchema) ?? null);
  return projected as ReturnType<typeof projectPluginActionInputDefinition>;
}

/** Localized presentation projects the same completed fields as execution/discovery. */
export function projectPluginActionLocalizedPresentation(
  definition: PluginActionContributionV2,
  projected: Readonly<{ inputHints: ActionInputHints | null }>,
): ResolvedActionLocalizedPresentation {
  const authored = definition.inputHints;
  const localize = (inputHints: ActionInputHints) => {
    const authoredByPath = new Map(authored?.fields.map(field => [field.path, field]));
    return {
      ...inputHints,
      ...authored,
      fields: inputHints.fields.map(field => authoredByPath.get(field.path) ?? field),
    };
  };
  const presentation: Record<string, unknown> = {
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
  };
  if (Object.getOwnPropertyDescriptor(projected, 'inputHints')?.get) {
    // Hints derived from a deferred schema stay deferred; a schema without
    // hints reads back as an absent key's value (undefined).
    defineDerivedDeclarationField(presentation, 'inputHints', [[projected, 'inputHints']],
      () => projected.inputHints ? localize(projected.inputHints) : undefined);
  } else if (projected.inputHints) {
    presentation.inputHints = localize(projected.inputHints);
  }
  return Object.freeze(presentation) as ResolvedActionLocalizedPresentation;
}
