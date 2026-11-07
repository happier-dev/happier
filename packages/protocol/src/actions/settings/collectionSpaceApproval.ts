/** Saved-space deletion removes a personal filter, never the work it lists. */
export function readCollectionSpaceDeletionApprovalV1(input: unknown): Readonly<{
  requiresApproval: true;
  uiConfirmationRequired: true;
  summary: string;
}> | null {
  if (input === null || typeof input !== 'object' || !('anchor' in input) || !('input' in input)) return null;
  const operation = input.input;
  if (operation === null || typeof operation !== 'object' || !('kind' in operation) || operation.kind !== 'collection_space') return null;
  if (!('entityKind' in operation) || !('mutation' in operation)) return null;
  const mutation = operation.mutation;
  if (mutation === null || typeof mutation !== 'object' || !('op' in mutation) || mutation.op !== 'delete') return null;
  const entityKind = operation.entityKind;
  if (entityKind !== 'sessionWork' && entityKind !== 'workflow' && entityKind !== 'discussion') return null;
  const prefix = entityKind === 'sessionWork' ? 'session' : entityKind;
  if (input.anchor !== `${prefix}.list.spaces`) return null;
  return { requiresApproval: true, uiConfirmationRequired: true,
    summary: 'Delete this saved space. Only the saved filter is removed; your work is kept.' };
}
