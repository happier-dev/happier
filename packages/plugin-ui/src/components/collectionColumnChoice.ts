import { useMemo } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** A Collection that offers the person its Columns choice: one stable id per table kind, never a row or a Machine. */
export type CollectionColumnsBinding = Readonly<{ collectionId: string }>;

type ChoiceField = Readonly<{ key: string; defaultHidden?: boolean }>;

/**
 * The fields the table draws, in the order the person chose: the shown keys picked from the declared fields (a
 * saved key whose field is gone draws nothing), or the declared default (every field not `defaultHidden`) when
 * there is no choice. The width owner still decides which of them fit.
 */
export function resolveCollectionShownFields<Field extends ChoiceField>(
  fields: readonly Field[],
  shownKeys: readonly string[] | null,
): readonly Field[] {
  if (shownKeys === null) {
    return fields.some((field) => field.defaultHidden === true)
      ? fields.filter((field) => field.defaultHidden !== true)
      : fields;
  }
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const shown = shownKeys.flatMap((key) => {
    const field = byKey.get(key);
    return field === undefined ? [] : [field];
  });
  return shown.length === fields.length &&
    shown.every((field, index) => field === fields[index])
    ? fields
    : shown;
}

function useNoColumnChoice(): null {
  return null;
}

/**
 * The anatomy's fields after the person's Columns choice. A collection without a binding draws its declared default.
 * The choice is read through the host's key-scoped owner and compared by its keys, so an unrelated preference write
 * (another collection's columns) returns the same fields and redraws no row.
 */
export function useCollectionShownFields<Field extends ChoiceField>(
  fields: readonly Field[] | undefined,
  binding: CollectionColumnsBinding | undefined,
): readonly Field[] | undefined {
  const host = useOptionalPluginUiPresentationHost();
  // The host and the binding are fixed for a mounted Collection, so this is the same hook on every render.
  const useShownFieldKeys =
    binding === undefined
      ? useNoColumnChoice
      : (host?.collectionColumns?.useShownFieldKeys ?? useNoColumnChoice);
  const declared = useMemo(
    () =>
      (fields ?? []).map((field) => ({
        key: field.key,
        defaultHidden: field.defaultHidden === true,
      })),
    [fields],
  );
  const shownKeys = useShownFieldKeys({
    collectionId: binding?.collectionId ?? '',
    fields: declared,
  });
  const shownSignature = shownKeys === null ? null : shownKeys.join('\u0000');
  return useMemo(
    () =>
      fields === undefined
        ? undefined
        : resolveCollectionShownFields(
            fields,
            shownSignature === null
              ? null
              : shownSignature === ''
                ? []
                : shownSignature.split('\u0000'),
          ),
    [fields, shownSignature],
  );
}
