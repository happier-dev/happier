import type { OpenCodeModelRef } from './types';
import { asRecord, normalizeString } from './openCodeParsing';

export function parseOpenCodeModelId(raw: string): OpenCodeModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, idx), modelID: trimmed.slice(idx + 1) };
}

export function resolveOpenCodeDefaultProviderIdFromModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const idx = trimmed.indexOf('/');
  if (idx <= 0) return '';
  return trimmed.slice(0, idx);
}

export function modelSupportsToolCalls(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const status = normalizeString(rec.status);
  if (status && status !== 'active') return false;
  const capabilities = asRecord(rec.capabilities);
  if (!capabilities) return false;
  if (capabilities.toolcall !== true) return false;
  const input = asRecord(capabilities.input);
  if (input && input.text === false) return false;
  return true;
}

