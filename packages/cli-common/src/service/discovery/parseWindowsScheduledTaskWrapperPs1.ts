import type { ParsedWindowsScheduledTaskWrapperPs1 } from './serviceDiscoveryTypes.js';
import {
  basenameWithoutSuffix,
  parsePowerShellCommandLine,
  parsePowerShellDoubleQuotedText,
} from './_shared.js';

function parseEnvAssignment(line: string): [string, string] | null {
  const match = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(line.trim());
  if (!match) return null;
  const key = String(match[1] ?? '').trim();
  const value = parsePowerShellDoubleQuotedText(String(match[2] ?? '').trim());
  if (!key) return null;
  return [key, value];
}

function extractPowerShellQuotedSegment(raw: string): string | null {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('"')) return null;

  let current = '';
  let escaping = false;
  for (let index = 1; index < text.length; index += 1) {
    const ch = text[index] ?? '';
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '`') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      return current;
    }
    current += ch;
  }

  return null;
}

function parseRedirectionPath(line: string, redirection: '1>>' | '2>>'): string | null {
  const index = line.indexOf(redirection);
  if (index < 0) return null;
  const value = extractPowerShellQuotedSegment(line.slice(index + redirection.length));
  return value === null ? null : parsePowerShellDoubleQuotedText(`"${value}"`);
}

export function parseWindowsScheduledTaskWrapperPs1(params: Readonly<{
  contents: string;
  sourcePath?: string;
}>): ParsedWindowsScheduledTaskWrapperPs1 | null {
  const label = basenameWithoutSuffix(params.sourcePath, '.ps1');
  if (!label) return null;

  const lines = String(params.contents ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const env: Record<string, string> = {};
  let workingDirectory: string | null = null;
  let commandLine = '';
  let stdoutPath: string | null = null;
  let stderrPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith('$ErrorActionPreference')) continue;

    if (line.startsWith('Set-Location -LiteralPath ')) {
      workingDirectory = parsePowerShellDoubleQuotedText(line.slice('Set-Location -LiteralPath '.length).trim());
      continue;
    }

    const envAssignment = parseEnvAssignment(line);
    if (envAssignment) {
      env[envAssignment[0]] = envAssignment[1];
      continue;
    }

    if (line.startsWith('& ')) {
      commandLine = line.slice(2).trim();
      stdoutPath = parseRedirectionPath(line, '1>>');
      stderrPath = parseRedirectionPath(line, '2>>');
    }
  }

  const redirectionIndex = commandLine.indexOf('1>>');
  const commandArgsRaw = (redirectionIndex >= 0 ? commandLine.slice(0, redirectionIndex) : commandLine).trim();
  const programArgs = parsePowerShellCommandLine(commandArgsRaw);
  if (programArgs.length === 0) return null;

  return {
    kind: 'windows-wrapper-ps1',
    label,
    workingDirectory,
    programArgs,
    env,
    stdoutPath,
    stderrPath,
  };
}
