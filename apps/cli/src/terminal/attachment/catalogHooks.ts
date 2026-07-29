import { readCatalogEntriesSnapshot } from '@/agent/catalog/registry';
import type { ProviderTerminalAttachmentRetirementHook } from '@/agent/catalog/types';

/**
 * Notifies provider owners after exact terminal-attachment retirement.
 *
 * The terminal disposition owner has already made retirement irreversible. Provider cleanup is
 * therefore advisory: callers log failures for retry/diagnostics but never resurrect the host.
 */
export const notifyTerminalAttachmentRetiredThroughCatalog: ProviderTerminalAttachmentRetirementHook = async (params) => {
  const hooks = Object.values(readCatalogEntriesSnapshot())
    .map((entry) => entry.onTerminalAttachmentRetired)
    .filter((hook): hook is ProviderTerminalAttachmentRetirementHook => hook !== undefined);
  await Promise.all(hooks.map(async (hook) => await hook(params)));
};
