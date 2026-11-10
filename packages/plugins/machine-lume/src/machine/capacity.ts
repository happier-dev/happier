import * as z from 'zod/mini';
import { LumeNativeDetailsSchema } from './schemas.js';

// Apple permits two macOS guests per Mac; Virtualization.framework enforces it.
// https://www.apple.com/legal/sla/docs/macOSTahoe.pdf §2B(iii)
// https://cua.ai/docs/spaces/guides/add-a-computer (Limits)
// Lume 0.6.1 starts asynchronously (Handlers.swift handleRunVM, HTTP202),
// so the framework's eventual refusal is not returned to the HTTP caller.
export const LUME_MACOS_VM_LIMIT = 2;
export const isLumeMacos = (os: string) => os.toLowerCase() === 'macos';

// Project only capacity and exact identity; never expose addresses or native bags.
const inventorySchema = z.array(z.object({ name: z.string(), locationName: z.string(), os: z.string(), status: z.string(), cpuCount: z.optional(LumeNativeDetailsSchema.shape.cpuCount) }));
export function readLumeCapacity(input: unknown) {
  const parsed = inventorySchema.safeParse(input);
  if (!parsed.success) return undefined;
  const runningMacosCount = parsed.data.filter(vm => isLumeMacos(vm.os) && vm.status === 'running').length;
  return { kind: 'inventory' as const, vms: parsed.data, runningMacosCount,
    macosStartRefusal: runningMacosCount >= LUME_MACOS_VM_LIMIT ? {
      kind: 'refused' as const, code: 'native_macos_vm_limit_reached' as const,
      nativeCause: { localCause: 'native_macos_vm_limit_reached' as const },
    } : undefined };
}
