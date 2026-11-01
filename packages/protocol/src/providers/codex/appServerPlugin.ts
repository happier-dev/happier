import { z } from 'zod';

import type { SessionVendorPluginSummaryV1 } from '../../sessionWorkState/sessionWorkStateRpc.js';
import { lazySchema } from '../../lazySchema.js';

export const CodexAppServerPluginSummarySchema = lazySchema(() => z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    installPolicy: z.string().min(1).optional(),
  })
  .passthrough());
export type CodexAppServerPluginSummary = z.infer<typeof CodexAppServerPluginSummarySchema>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveVendorPluginRef(plugin: CodexAppServerPluginSummary): string | null {
  const explicitPath = readString(plugin.path);
  if (explicitPath) return explicitPath;
  const id = readString(plugin.id);
  return id?.startsWith('plugin://') ? id : null;
}

export function normalizeCodexAppServerPluginSummaries(value: unknown): SessionVendorPluginSummaryV1[] {
  const plugins = Array.isArray(value) ? value : [];
  return plugins.flatMap((plugin): SessionVendorPluginSummaryV1[] => {
    const parsed = CodexAppServerPluginSummarySchema.safeParse(plugin);
    if (!parsed.success) return [];
    const vendorPluginRef = resolveVendorPluginRef(parsed.data);
    const name = readString(parsed.data.name) ?? readString(parsed.data.id);
    if (!vendorPluginRef || !name) return [];
    const enabled = parsed.data.enabled === true;
    const installed = parsed.data.installed === true;
    return [{
      vendorPluginRef,
      name,
      ...(readString(parsed.data.displayName) ? { displayName: readString(parsed.data.displayName) as string } : {}),
      ...(readString(parsed.data.description) ? { description: readString(parsed.data.description) as string } : {}),
      ...(typeof parsed.data.installed === 'boolean' ? { installed: parsed.data.installed } : {}),
      ...(typeof parsed.data.enabled === 'boolean' ? { enabled: parsed.data.enabled } : {}),
      mentionable: installed && enabled,
      ...(readString(parsed.data.installPolicy) ? { installPolicy: readString(parsed.data.installPolicy) as string } : {}),
    }];
  });
}
