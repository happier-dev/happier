import { utf8ByteLength } from '../../bugs/reports/utf8.js';
import type { SettingsDeclarationDescriptorV1 } from '../settingsDeclarationActionFamily.js';

type DiscoveryInput = Readonly<{ maxBytes?: number; cursor?: number }>;
type DiscoveryResult = { items: SettingsDeclarationDescriptorV1[]; total?: number; nextCursor?: number };

function insufficientBudget(minimumBytes: number) {
  return { ok: false as const, errorCode: 'settings_discovery_budget_too_small' as const,
    error: 'settings_discovery_budget_too_small', details: { minimumBytes } };
}

/** The delivery caller owns the budget. Ordinary discovery remains complete and unbounded. */
export function projectSettingsDeclarationDiscoveryV1(items: SettingsDeclarationDescriptorV1[], input: DiscoveryInput):
  DiscoveryResult | { ok: false; errorCode: 'settings_discovery_budget_too_small'; error: string; details: { minimumBytes: number } } {
  if (input.maxBytes === undefined && input.cursor === undefined) return { items };
  const start = input.cursor ?? 0;
  const selected: SettingsDeclarationDescriptorV1[] = [];
  let itemBytes = 0;
  for (let index = start; index < items.length; index += 1) {
    const next = index + 1;
    const continuation = next < items.length ? { nextCursor: next } : {};
    const addedBytes = utf8ByteLength(JSON.stringify(items[index])) + (selected.length ? 1 : 0);
    const resultBytes = utf8ByteLength(JSON.stringify({ items: [], total: items.length, ...continuation }))
      + itemBytes + addedBytes;
    if (input.maxBytes !== undefined && resultBytes > input.maxBytes) {
      if (!selected.length) return insufficientBudget(resultBytes);
      return { items: selected, total: items.length, nextCursor: index };
    }
    selected.push(items[index]);
    itemBytes += addedBytes;
  }
  const result = { items: selected, total: items.length };
  if (!selected.length && input.maxBytes !== undefined) {
    const resultBytes = utf8ByteLength(JSON.stringify(result));
    if (resultBytes > input.maxBytes) return insufficientBudget(resultBytes);
  }
  return result;
}
