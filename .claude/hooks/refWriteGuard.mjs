import { readFileSync } from 'node:fs';

// Inspect every literal Git invocation, including shell substitutions. This is
// a command guard, not a shell evaluator: no part of the command is executed.
const command = readFileSync(0, 'utf8');
const head = (ref) => ref === 'HEAD' || ref?.startsWith('refs/heads/');
const word = /"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()`<>]+|[;&|()`<>\n]/g;
for (const invocation of command.matchAll(/\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|[^\s;&|()`]+)\s+)*(update-ref|symbolic-ref)\b/g)) {
  const tail = command.slice(invocation.index + invocation[0].length);
  const args = [];
  for (const [value] of tail.matchAll(word)) {
    if (/^[;&|()`<>\n]$/.test(value)) break;
    args.push(value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const positional = [];
  let stdin = false;
  let deletion = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m') { i++; continue; }
    if (args[i] === '--stdin') stdin = true;
    else if (args[i] === '-d' || args[i] === '--delete') deletion = true;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  let blocked;
  if (invocation[1] === 'symbolic-ref') {
    blocked = positional[0] === 'HEAD' && (deletion || positional.length > 1);
  } else if (stdin) {
    // Streamed head writes bypass positional CAS enforcement. Literal tag/other
    // streams remain usable; opaque stdin is refused because its target is unknown.
    const prefix = command.slice(0, invocation.index).split(/[;&\n]/).at(-1);
    const heredoc = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)(?:\n\1\b|$)/.exec(tail);
    const stream = heredoc?.[2] ?? prefix;
    const targets = [...stream.matchAll(/(?:^|\\[n0]|[\s\0'"])(?:update|create|delete|verify|symref-(?:update|create|delete|verify))\s+(?:"([^"]+)"|([^\s\\'"]+))/g)]
      .map((match) => match[1] ?? match[2]);
    blocked = targets.length === 0 || targets.some(head);
  } else {
    blocked = head(positional[0]) && positional.length < (deletion ? 2 : 3);
  }
  if (blocked) {
    process.stdout.write(`git ${invocation[1]} (HEAD/branch writes require an old value; streamed head writes are forbidden)`);
    break;
  }
}
