import type { ReactNode } from 'react';
import {
  readForgeCiTriggerValuesV1, updateForgeCiTriggerDraftV1, type ForgeCiTriggerDraftV1,
} from '../runtime/triggerFields.js';

export type ForgeCiTriggerFormProps = Readonly<{
  draft: ForgeCiTriggerDraftV1;
  onDraftChange(draft: ForgeCiTriggerDraftV1): void;
  children(model: Readonly<{
    draft: ForgeCiTriggerDraftV1;
    values: ReturnType<typeof readForgeCiTriggerValuesV1>;
    onInputChange(input: Readonly<Record<string, unknown>>): void;
  }>): ReactNode;
}>;

/** Bind the public Form to these canonical fields/drafts; visual composition belongs to its caller. */
export function ForgeCiTriggerForm(props: ForgeCiTriggerFormProps): ReactNode {
  return props.children({
    draft: props.draft,
    values: readForgeCiTriggerValuesV1(props.draft),
    onInputChange: input => props.onDraftChange(updateForgeCiTriggerDraftV1(props.draft, input)),
  });
}
