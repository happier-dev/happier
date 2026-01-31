import { ansiEnabled, bold, cyan, dim, green, red, yellow } from './ansi.mjs';

function icon(s) {
  // Keep icons TTY-friendly; avoid icons when color is disabled to reduce noise in logs.
  return ansiEnabled() ? String(s) : '';
}

export function cmd(s) {
  return yellow(String(s));
}

export function ok(s) {
  return `${green('✓')}${s ? ` ${s}` : ''}`;
}

export function warn(s) {
  return `${yellow('!')}${s ? ` ${s}` : ''}`;
}

export function fail(s) {
  return `${red('x')}${s ? ` ${s}` : ''}`;
}

export function kv(label, value) {
  return `${dim(label)} ${value}`;
}

export function sectionTitle(title) {
  return bold(String(title));
}

export function banner(title, { subtitle = '', prefix = '✨', suffix = '✨' } = {}) {
  const pre = icon(prefix);
  const suf = icon(suffix);
  const t = `${pre ? `${pre} ` : ''}${cyan(title)}${suf ? ` ${suf}` : ''}`;
  const lines = [bold(t)];
  if (subtitle) lines.push(dim(subtitle));
  return lines.join('\n');
}

export function bullets(lines) {
  return (lines ?? []).map((l) => `- ${l}`).join('\n');
}

