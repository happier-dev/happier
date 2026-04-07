import type { ParsedSystemdUnit } from './serviceDiscoveryTypes.js';
import {
  basenameWithoutSuffix,
  parseSystemdCommandLine,
  parseSystemdEscapedText,
} from './_shared.js';

function collectSectionLines(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentSection = '';

  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? '';
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (!currentSection || !trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const list = sections.get(currentSection) ?? [];
    list.push(trimmed);
    sections.set(currentSection, list);
  }

  return sections;
}

function parseEnvironmentLine(line: string): [string, string] | null {
  const prefix = 'Environment=';
  if (!line.startsWith(prefix)) return null;
  const raw = line.slice(prefix.length);
  const index = raw.indexOf('=');
  if (index <= 0) return null;
  const key = raw.slice(0, index).trim();
  if (!key) return null;
  const value = parseSystemdEscapedText(raw.slice(index + 1));
  return [key, value];
}

function stripOutputPrefix(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('append:')) return trimmed.slice('append:'.length);
  return trimmed;
}

export function parseSystemdUnit(params: Readonly<{
  contents: string;
  sourcePath?: string;
}>): ParsedSystemdUnit | null {
  const label = basenameWithoutSuffix(params.sourcePath, '.service');
  if (!label) return null;

  const sections = collectSectionLines(params.contents);
  const unitLines = sections.get('Unit') ?? [];
  const serviceLines = sections.get('Service') ?? [];
  const installLines = sections.get('Install') ?? [];

  const description = unitLines
    .map((line) => line.startsWith('Description=') ? line.slice('Description='.length).trim() : '')
    .find(Boolean) ?? '';
  const execStartLine = serviceLines.find((line) => line.startsWith('ExecStart='));
  const programArgs = execStartLine ? parseSystemdCommandLine(execStartLine.slice('ExecStart='.length)) : [];
  if (programArgs.length === 0) return null;

  const env: Record<string, string> = {};
  for (const line of serviceLines) {
    const parsed = parseEnvironmentLine(line);
    if (!parsed) continue;
    env[parsed[0]] = parsed[1];
  }

  const workingDirectory = serviceLines
    .map((line) => line.startsWith('WorkingDirectory=') ? line.slice('WorkingDirectory='.length).trim() : '')
    .find(Boolean) || null;
  const runAsUser = serviceLines
    .map((line) => line.startsWith('User=') ? line.slice('User='.length).trim() : '')
    .find(Boolean) || null;
  const stdoutPath = serviceLines
    .map((line) => line.startsWith('StandardOutput=') ? stripOutputPrefix(line.slice('StandardOutput='.length)) : '')
    .find(Boolean) || null;
  const stderrPath = serviceLines
    .map((line) => line.startsWith('StandardError=') ? stripOutputPrefix(line.slice('StandardError='.length)) : '')
    .find(Boolean) || null;
  const restart = serviceLines
    .map((line) => line.startsWith('Restart=') ? line.slice('Restart='.length).trim() : '')
    .find(Boolean) || null;
  const wantedBy = installLines
    .map((line) => line.startsWith('WantedBy=') ? line.slice('WantedBy='.length).trim() : '')
    .find(Boolean) || null;

  return {
    kind: 'systemd-unit',
    label,
    description,
    programArgs,
    env,
    workingDirectory,
    runAsUser,
    stdoutPath,
    stderrPath,
    restart,
    wantedBy,
  };
}
