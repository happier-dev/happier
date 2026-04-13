import { asRecord, normalizeString } from './openCodeParsing';

function normalizePartType(value: unknown): string {
  return normalizeString(value).trim().toLowerCase();
}

function extractRenderableTextFromNestedValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';

  const parts: string[] = [];
  for (const entry of value) {
    const text = extractOpenCodeRenderableTextFromPart(entry);
    if (text) parts.push(text);
  }
  return parts.join('').trim();
}

export function extractOpenCodeRenderableTextFromPart(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return '';

  const type = normalizePartType(rec.type);
  if (!type) return '';
  if (type === 'reasoning' || type === 'thinking' || type === 'step-finish') return '';
  if (type !== 'text' && type !== 'step') return '';

  const directText = normalizeString(rec.text).trim();
  if (directText) return directText;

  const contentText = extractRenderableTextFromNestedValue(rec.content);
  if (contentText) return contentText;

  return extractRenderableTextFromNestedValue(rec.parts);
}

export function extractOpenCodeRenderableTextFromMessage(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return '';

  const content = rec.content;
  if (typeof content === 'string') return content.trim();

  const contentText = extractRenderableTextFromNestedValue(content);
  if (contentText) return contentText;

  const partsText = extractRenderableTextFromNestedValue(rec.parts);
  if (partsText) return partsText;

  return normalizeString(rec.text).trim();
}
