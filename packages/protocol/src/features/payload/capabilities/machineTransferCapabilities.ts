import { z } from 'zod';

import type { FeaturesResponse } from '../featuresResponseSchema.js';
import { isRecord } from '../isRecord.js';

export const MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY =
  'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES';

export function normalizeMachineTransferServerRoutedMaxBytes(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

export const MachineTransferServerRoutedCapabilitiesSchema = z.object({
  maxBytes: z
    .preprocess((raw) => normalizeMachineTransferServerRoutedMaxBytes(raw), z.number().int().positive().nullable())
    .optional()
    .default(null),
});

export type MachineTransferServerRoutedCapabilities = z.infer<typeof MachineTransferServerRoutedCapabilitiesSchema>;

export const DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_CAPABILITIES: MachineTransferServerRoutedCapabilities = {
  maxBytes: null,
};

export const MachineTransferCapabilitiesSchema = z.object({
  serverRouted: MachineTransferServerRoutedCapabilitiesSchema.optional().default(
    DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_CAPABILITIES,
  ),
});

export type MachineTransferCapabilities = z.infer<typeof MachineTransferCapabilitiesSchema>;

export const DEFAULT_MACHINE_TRANSFER_CAPABILITIES: MachineTransferCapabilities = {
  serverRouted: DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_CAPABILITIES,
};

export function readMachineTransferServerRoutedMaxBytes(
  features: Pick<FeaturesResponse, 'capabilities'> | null | undefined,
): number | null {
  const capabilities = features && isRecord(features.capabilities) ? features.capabilities : null;
  const machines = capabilities && isRecord(capabilities.machines) ? capabilities.machines : null;
  const transfer = machines && isRecord(machines.transfer) ? machines.transfer : null;
  const serverRouted = transfer && isRecord(transfer.serverRouted) ? transfer.serverRouted : null;
  return normalizeMachineTransferServerRoutedMaxBytes(serverRouted?.maxBytes);
}
