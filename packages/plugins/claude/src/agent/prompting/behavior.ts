export function resolveClaudeCodingPromptBehaviorBlocks(args: Readonly<{
  disableTodos?: boolean;
}>): readonly Readonly<{
  id: string;
  scope: 'provider_behavior';
  text: string;
}>[] {
  const blocks = [{
    id: 'provider.claude.ask_user_question_isolation',
    scope: 'provider_behavior' as const,
    text: [
      'RELIABILITY RULES (IMPORTANT):',
      "- Tool-use sequencing is strict. If you use \"AskUserQuestion\", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.",
    ].join('\n'),
  }];

  if (args.disableTodos === true) {
    return [
      ...blocks,
      {
        id: 'provider.claude.disable_todos',
        scope: 'provider_behavior',
        text: 'Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.',
      },
    ];
  }

  return blocks;
}
