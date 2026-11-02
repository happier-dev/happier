import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Codex normalizes shell/exec_command to Bash and tool_input.command.
// Keep all Git policy in the existing Claude guard; translate only its envelope and exit code.
try {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const guard = fileURLToPath(new URL('../../.claude/hooks/prevent-destructive-git.sh', import.meta.url));
  const result = spawnSync('bash', [guard.replaceAll('\\', '/')], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout || result.stderr || 'Destructive Git guard could not run.\n');
    // Claude's guard uses exit 1; Codex requires exit 2 to block before execution.
    process.exitCode = 2;
  }
} catch {
  process.stderr.write('Destructive Git guard could not read hook input.\n');
  process.exitCode = 2;
}
