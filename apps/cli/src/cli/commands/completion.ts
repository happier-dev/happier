import type { CommandContext } from '@/cli/commandRegistry';

const scripts = Object.freeze({
  bash: `_happier_completion() {
  local IFS=$'\\n'
  COMPREPLY=($(happier completion candidates -- "\${COMP_WORDS[@]:1}"))
}
complete -F _happier_completion happier`,
  zsh: `#compdef happier
_happier_completion() {
  local -a candidates
  candidates=("\${(@f)$(happier completion candidates -- "\${words[@]:2}")}")
  compadd -- "\${candidates[@]}"
}
compdef _happier_completion happier`,
  fish: `function __happier_completion
  happier completion candidates -- (commandline -opc | string split ' ')[2..]
end
complete -c happier -f -a '(__happier_completion)'`,
  powershell: `Register-ArgumentCompleter -Native -CommandName happier -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  happier completion candidates -- @words | Where-Object { $_ -like "$wordToComplete*" }
}`,
});

export async function handleCompletionCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  if (args[0] === 'candidates') {
    const { ensureMergedAgentCommandRegistryLoaded, resolveCommandCompletionCandidates } = await import('@/cli/commandRegistry');
    await ensureMergedAgentCommandRegistryLoaded();
    const separator = args.indexOf('--');
    const words = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
    const candidates = resolveCommandCompletionCandidates(words);
    if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
    return;
  }
  const shell = args[0] as keyof typeof scripts | undefined;
  if (!shell || !Object.prototype.hasOwnProperty.call(scripts, shell)) {
    throw new Error('Usage: happier completion <bash|zsh|fish|powershell>');
  }
  process.stdout.write(`${scripts[shell]}\n`);
}
