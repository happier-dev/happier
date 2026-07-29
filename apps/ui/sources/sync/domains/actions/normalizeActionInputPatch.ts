import {
  ActionIdSchema,
  getActionSpec,
  normalizeActionInputByFieldHints,
  type ActionId,
} from '@happier-dev/protocol';

function resolveActionSpec(actionId: ActionId | string) {
  const parsed = ActionIdSchema.safeParse(actionId);
  return parsed.success ? getActionSpec(parsed.data) : null;
}

export function normalizeActionInput(args: Readonly<{
  actionId: ActionId | string;
  input: Record<string, unknown>;
}>): Record<string, unknown> {
  const spec = resolveActionSpec(args.actionId);
  return spec ? normalizeActionInputByFieldHints(spec, args.input) : args.input;
}

export function normalizeActionInputPatch(args: Readonly<{
  actionId: ActionId | string;
  patch: Record<string, unknown>;
}>): Record<string, unknown> {
  return normalizeActionInput({ actionId: args.actionId, input: args.patch });
}
