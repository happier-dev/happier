import { readFileSync } from 'node:fs';
import { evaluateGitGuard } from '../../.claude/hooks/prevent-destructive-git.mjs';

// Codex normalizes shell/exec_command to Bash and tool_input.command.
// Keep all Git policy in the Claude evaluator; translate only its envelope and exit code.
try {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const result = evaluateGitGuard(event);
  if (result.status !== 0) {
    process.stderr.write(result.stdout || result.stderr || 'Destructive Git guard could not run.\n');
    // Claude's guard uses exit 1; Codex requires exit 2 to block before execution.
    process.exitCode = 2;
  }
} catch {
  process.stderr.write('Destructive Git guard could not read hook input.\n');
  process.exitCode = 2;
}
