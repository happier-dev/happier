export function resolveCodexCodingPromptBehaviorBlocks(): readonly Readonly<{
  id: string;
  scope: 'provider_behavior';
  text: string;
}>[] {
  return [{
    id: 'provider.codex.exec_sequencing',
    scope: 'provider_behavior',
    text: [
      'Tool execution ordering:',
      '- When you need to run multiple `exec_command` calls, run them sequentially.',
      '- Do not enqueue multiple `exec_command` calls at once.',
      '- If any command may require user approval (especially writes), wait for the user decision and the command result before issuing the next command.',
      '- If a dependent read runs before its prerequisite write and fails, rerun the read after the write succeeds.',
    ].join('\n'),
  }];
}
