import * as React from 'react';
import {
  resolveEffectiveActionInputFields,
  type ActionInputHints,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { readHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import type { InputTypePickerHostContext } from '@/components/sessions/actions/InputTypePickerHostProvider';

/** A recipe's own options are static, so there is nothing to read: the resolver only projects what it declares. */
const STATIC_OPTIONS = buildSessionActionFieldOptionsResolver({});

export type SoftwareInputDraft = Readonly<Record<string, unknown>>;

/**
 * What the form holds is text as typed; the recipe's schema speaks of values that are present or absent. A box left
 * empty is absent, and an object with nothing left in it is absent too, so an optional exact pin never reaches the
 * owner as an empty string.
 */
export function omitBlankSoftwareInputs(value: unknown): JsonValue | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (Array.isArray(value))
    return value.flatMap((item) => omitBlankSoftwareInputs(item) ?? []);
  if (value && typeof value === 'object') {
    const kept = Object.entries(value).flatMap(([key, item]) => {
      const next = omitBlankSoftwareInputs(item);
      return next === undefined ? [] : [[key, next] as const];
    });
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
  }
  return value as JsonValue | undefined;
}

/** The fields the draft shows now, and the title of the first required one still empty (the reason Install waits). */
export function readSoftwareInputFields(
  hints: ActionInputHints | undefined,
  draft: SoftwareInputDraft,
) {
  const fields = resolveEffectiveActionInputFields(
    { inputHints: hints },
    draft,
  ).filter((field) => field.visible);
  const missing = fields.find(
    (field) =>
      field.required &&
      omitBlankSoftwareInputs(readHappierActionInputPath(draft, field.path)) === undefined,
  );
  return { fields, missing: missing?.title ?? null };
}

/** The recipe's declared input form, drawn by the one Action input-field owner. */
export function SoftwareInputFields(
  props: Readonly<{
    fields: ReturnType<typeof readSoftwareInputFields>['fields'];
    draft: SoftwareInputDraft;
    onPatch: (patch: Record<string, unknown>) => void;
    testID: string;
    pickerContext?: InputTypePickerHostContext;
  }>,
): React.ReactNode {
  const resolveFieldOptions = React.useMemo(() => props.pickerContext
    ? Object.assign(buildSessionActionFieldOptionsResolver({}), { pickerContext: props.pickerContext })
    : STATIC_OPTIONS, [props.pickerContext]);
  return (
    <ActionInputFields
      fields={props.fields}
      input={{ ...props.draft }}
      editable
      resolveFieldOptions={resolveFieldOptions}
      resolveFieldTestID={(field) => `${props.testID}.${field.path}`}
      onPatch={props.onPatch}
    />
  );
}
