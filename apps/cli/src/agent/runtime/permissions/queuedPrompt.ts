export type PermissionModeQueuedPrompt = Readonly<{
  text: string;
  localId: string | null;
}>;

export function combinePermissionModeQueuedPrompts(
  prompts: readonly PermissionModeQueuedPrompt[],
): PermissionModeQueuedPrompt {
  const [first] = prompts;
  return {
    text: prompts.map((prompt) => prompt.text).join('\n'),
    localId: first?.localId ?? null,
  };
}
