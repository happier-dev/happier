import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

function isStrictPlainDataGraph(root: unknown): boolean {
  try {
    const activeAncestors = new WeakSet<object>();
    const pending: Array<Readonly<{ value: unknown; exit: boolean }>> = [{
      value: root,
      exit: false,
    }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const value = current.value;
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        continue;
      }
      if (typeof value !== 'object') return false;
      if (current.exit) {
        activeAncestors.delete(value);
        continue;
      }
      if (activeAncestors.has(value)) return false;
      activeAncestors.add(value);
      pending.push({ value, exit: true });

      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) return false;
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0) return false;
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== 'string'
          || (key !== 'length' && (!/^\d+$/u.test(key)
            || String(Number(key)) !== key
            || Number(key) >= length)))) {
          return false;
        }
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return false;
          pending.push({ value: descriptor.value, exit: false });
        }
        continue;
      }
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return false;
        pending.push({ value: descriptor.value, exit: false });
      }
    }
    return true;
  } catch {
    return false;
  }
}

const StrictPlainDataSchema = z.custom<unknown>(isStrictPlainDataGraph, {
  message: 'Connected-account identity must contain strict plain data',
});

export const QualifiedConnectedAccountIdSchema = z.string().trim().min(1).max(256);

export const QualifiedConnectedAccountRefSchema = StrictPlainDataSchema.pipe(z.object({
  service: StrictPlainDataSchema.pipe(PluginContributionIdentityV1Schema),
  accountId: QualifiedConnectedAccountIdSchema,
}).strict());

export type QualifiedConnectedAccountRef = z.infer<typeof QualifiedConnectedAccountRefSchema>;
