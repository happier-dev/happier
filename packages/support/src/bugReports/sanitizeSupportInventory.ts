import { sanitizeBugReportArtifactPath } from '@happier-dev/protocol';

import type {
  SupportInstallationEntry,
  SupportRuntimeInventory,
  SupportRuntimeTargetEntry,
  SupportServiceEntry,
} from '../types.js';

function sanitizeInstallationEntry(entry: SupportInstallationEntry): SupportInstallationEntry {
  return {
    ...entry,
    path: sanitizeBugReportArtifactPath(entry.path) ?? entry.path,
    realPath: sanitizeBugReportArtifactPath(entry.realPath) ?? entry.realPath,
  };
}

function sanitizeServiceEntry(entry: SupportServiceEntry): SupportServiceEntry {
  return {
    ...entry,
    path: sanitizeBugReportArtifactPath(entry.path) ?? entry.path,
    executablePath: sanitizeBugReportArtifactPath(entry.executablePath) ?? entry.executablePath,
    linkedInstallationPath: sanitizeBugReportArtifactPath(entry.linkedInstallationPath) ?? entry.linkedInstallationPath,
    linkedRuntimeTargetPath: sanitizeBugReportArtifactPath(entry.linkedRuntimeTargetPath) ?? entry.linkedRuntimeTargetPath,
    serverUrl: sanitizeBugReportArtifactPath(entry.serverUrl) ?? entry.serverUrl,
    publicServerUrl: sanitizeBugReportArtifactPath(entry.publicServerUrl) ?? entry.publicServerUrl,
  };
}

function sanitizeRuntimeTargetEntry(entry: SupportRuntimeTargetEntry): SupportRuntimeTargetEntry {
  return {
    ...entry,
    path: sanitizeBugReportArtifactPath(entry.path) ?? entry.path,
    executablePath: sanitizeBugReportArtifactPath(entry.executablePath) ?? entry.executablePath,
  };
}

export function sanitizeSupportInventoryForArtifactUpload(inventory: SupportRuntimeInventory): SupportRuntimeInventory {
  return {
    ...inventory,
    invokedBinaryPath: sanitizeBugReportArtifactPath(inventory.invokedBinaryPath) ?? inventory.invokedBinaryPath,
    installations: inventory.installations.map(sanitizeInstallationEntry),
    services: inventory.services.map(sanitizeServiceEntry),
    runtimeTargets: inventory.runtimeTargets.map(sanitizeRuntimeTargetEntry),
  };
}
