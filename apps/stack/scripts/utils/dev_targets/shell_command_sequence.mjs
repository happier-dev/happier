import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Workspace manifests use direct argv commands and sequential &&/; commands.
// This is intentionally not a general shell interpreter.
export function workspaceBuildSequence(script) {
  if (/[$`\\\r\n]/u.test(script)) return null;
  const commands = [[]];
  const operators = [];
  const sources = [];
  let commandStart = 0;
  const tokens = /"[^"\r\n]*"|'[^'\r\n]*'|&&|;|[^\s;&|<>`$"']+/gu;
  let end = 0;
  for (const match of script.matchAll(tokens)) {
    if (script.slice(end, match.index).trim()) return null;
    const token = match[0];
    end = match.index + token.length;
    if (token === '&&' || token === ';') {
      if (!commands.at(-1).length) return null;
      operators.push(match[0].trim());
      sources.push(script.slice(commandStart, match.index).trim());
      commandStart = end;
      commands.push([]);
    } else {
      commands.at(-1).push(token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token);
    }
  }
  if (script.slice(end).trim() || !commands.at(-1).length) return null;
  sources.push(script.slice(commandStart).trim());
  return { commands, operators, sources };
}

export function workspaceBuildCommands(script) {
  return workspaceBuildSequence(script)?.commands ?? null;
}

// Read only the static prefix of an inline or repository-owned shell batch.
// Callers must stop at unknown commands before assigning placement demand.
export async function readShellCommandPrefix(commandArgs, { repoRoot, cwd }) {
  let script;
  if (commandArgs.length === 3 && /^-[a-z]*c[a-z]*$/u.test(commandArgs[1])) {
    script = commandArgs[2];
  } else if (commandArgs.length >= 2 && !commandArgs[1].startsWith('-')) {
    const path = resolve(repoRoot, cwd, commandArgs[1]);
    const fromRoot = relative(repoRoot, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return [];
    try { script = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  } else return [];
  const prefix = [];
  for (const line of script.split(/\r?\n/u)) {
    const source = line.trim();
    if (!source || source.startsWith('#') || /^set\s+-(?:[eu]+|[eu]*o\s+pipefail)\s*$/u.test(source)) continue;
    const commands = workspaceBuildCommands(source);
    if (!commands) break;
    prefix.push(...commands);
  }
  return prefix;
}
