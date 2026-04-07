import { sanitizeBugReportArtifactPath } from '@happier-dev/protocol';

import type { SupportInventoryEntry, SupportRuntimeInventory } from '../types.js';

function sanitizeInventoryEntryPath(entry: SupportInventoryEntry): SupportInventoryEntry {
  if (!entry.path) {
    return entry;
  }
  return {
    ...entry,
    path: sanitizeBugReportArtifactPath(entry.path),
  };
}

export function sanitizeSupportInventoryForArtifactUpload(inventory: SupportRuntimeInventory): SupportRuntimeInventory {
  return {
    ...inventory,
    invokedBinaryPath: sanitizeBugReportArtifactPath(inventory.invokedBinaryPath) ?? inventory.invokedBinaryPath,
    installations: inventory.installations.map(sanitizeInventoryEntryPath),
    services: inventory.services.map(sanitizeInventoryEntryPath),
  };
}
