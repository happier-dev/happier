import { basename, win32 as win32Path } from 'node:path';

export function stripSuffix(value: string, suffix: string): string {
  const text = String(value ?? '');
  const normalizedSuffix = String(suffix ?? '');
  if (!normalizedSuffix) return text;
  return text.endsWith(normalizedSuffix) ? text.slice(0, text.length - normalizedSuffix.length) : text;
}

export function basenameWithoutSuffix(sourcePath: string | undefined, suffix: string): string | null {
  const pathText = String(sourcePath ?? '').trim();
  if (!pathText) return null;
  const base = /[\\:]/u.test(pathText) ? win32Path.basename(pathText) : basename(pathText);
  return stripSuffix(base, suffix);
}

export function decodeXmlEntities(raw: string): string {
  return String(raw ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function captureSingleXmlValue(params: Readonly<{
  text: string;
  key: string;
  valueTag: 'string' | 'integer' | 'true' | 'false';
}>): string | null {
  const escapedKey = escapeRegExp(params.key);
  const match = new RegExp(
    `<key>${escapedKey}<\\/key>\\s*<${params.valueTag}>([\\s\\S]*?)<\\/${params.valueTag}>`,
    'i',
  ).exec(String(params.text ?? ''));
  if (!match) return null;
  return decodeXmlEntities(match[1] ?? '');
}

export function captureXmlBoolean(params: Readonly<{ text: string; key: string }>): boolean | null {
  const escapedKey = escapeRegExp(params.key);
  const match = new RegExp(
    `<key>${escapedKey}<\\/key>\\s*(<true\\s*\\/\\s*>|<false\\s*\\/\\s*>)`,
    'i',
  ).exec(String(params.text ?? ''));
  if (!match) return null;
  return /<true/i.test(match[1] ?? '');
}

export function captureXmlBlock(params: Readonly<{ text: string; key: string; tag: 'array' | 'dict' }>): string | null {
  const escapedKey = escapeRegExp(params.key);
  const match = new RegExp(
    `<key>${escapedKey}<\\/key>\\s*<${params.tag}>([\\s\\S]*?)<\\/${params.tag}>`,
    'i',
  ).exec(String(params.text ?? ''));
  if (!match) return null;
  return match[1] ?? '';
}

export function captureXmlStrings(block: string): string[] {
  return [...String(block ?? '').matchAll(/<string>([\s\S]*?)<\/string>/gi)].map((match) => decodeXmlEntities(match[1] ?? ''));
}

export function captureXmlInt(params: Readonly<{ text: string; key: string }>): number | null {
  const raw = captureSingleXmlValue({ text: params.text, key: params.key, valueTag: 'integer' });
  if (raw === null) return null;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export function parseSystemdEscapedText(raw: string): string {
  const text = String(raw ?? '');
  const quoted = text.startsWith('"') && text.endsWith('"');
  const inner = quoted ? text.slice(1, -1) : text;
  return inner
    .replaceAll('\\\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\')
    .replaceAll('%%', '%');
}

export function parseSystemdCommandLine(raw: string): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch === 'n' ? '\n' : ch;
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current.replaceAll('%%', '%'));
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  if (current) tokens.push(current.replaceAll('%%', '%'));
  return tokens;
}

export function parsePowerShellDoubleQuotedText(raw: string): string {
  const text = String(raw ?? '');
  const quoted = text.startsWith('"') && text.endsWith('"');
  const inner = quoted ? text.slice(1, -1) : text;
  return inner
    .replaceAll('``', '`')
    .replaceAll('`"', '"');
}

export function parsePowerShellCommandLine(raw: string): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (inQuotes && ch === '`') {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += '`';
  if (current) tokens.push(current);
  return tokens;
}

export function parseKeyValueLines(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key) continue;
    values[key] = trimmed.slice(index + 1);
  }
  return values;
}

function escapeRegExp(value: string): string {
  return String(value ?? '').replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
