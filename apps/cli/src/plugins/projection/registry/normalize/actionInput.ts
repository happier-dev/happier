import type { ActionInputHints, PluginActionContributionV2 } from '@happier-dev/protocol';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { ResolvedActionLocalizedPresentation } from '../types';

/** The input facet shared by full Action normalization and admitted listings. */
export function projectPluginActionInputDefinition(definition: PluginActionContributionV2): Readonly<{
  id: string;
  inputSchema?: PluginActionContributionV2['inputSchema'];
  inputHints: ActionInputHints | null;
}> {
  return {
    id: definition.id,
    ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
    inputHints: normalizePluginActionInputHintsV2(definition.inputHints, definition.inputSchema) ?? null,
  };
}

/** Localized presentation projects the same completed fields as execution/discovery. */
export function projectPluginActionLocalizedPresentation(
  definition: PluginActionContributionV2,
  inputHints: ActionInputHints | null,
): ResolvedActionLocalizedPresentation {
  const authored = definition.inputHints;
  const authoredByPath = new Map(authored?.fields.map(field => [field.path, field]));
  return Object.freeze({
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(inputHints ? { inputHints: {
      ...inputHints,
      ...authored,
      fields: inputHints.fields.map(field => authoredByPath.get(field.path) ?? field),
    } } : {}),
  });
}
