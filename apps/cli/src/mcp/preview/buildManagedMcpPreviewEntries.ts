import {
  inferMcpServerAuthModeV1,
  type ManagedMcpPreviewEntryV1,
  type ResolveManagedSessionMcpSelectionV1Result,
} from '@happier-dev/protocol';

import { resolveManagedMcpDirectEndpoint } from '../servers/managedMcpDirectEndpoint';

function resolveManagedScopeKind(item: ResolveManagedSessionMcpSelectionV1Result['itemsByName'][string]): ManagedMcpPreviewEntryV1['scopeKind'] {
  if (item.bindingTargetKind === 'allMachines' || item.bindingTargetKind === 'machine' || item.bindingTargetKind === 'workspace') {
    return item.bindingTargetKind;
  }
  return item.portability === 'portable' ? 'allMachines' : 'machine';
}

export function buildManagedMcpPreviewEntries(
  selection: ResolveManagedSessionMcpSelectionV1Result,
): ManagedMcpPreviewEntryV1[] {
  return Object.values(selection.itemsByName)
    .map((item) => ({
      key: `managed:${item.serverId}`,
      serverId: item.serverId,
      name: item.name,
      ...(item.title ? { title: item.title } : {}),
      transport: item.transport,
      authMode: inferMcpServerAuthModeV1(item.effectiveConfig),
      ...(item.transport !== 'stdio' ? {
        acpDelivery: resolveManagedMcpDirectEndpoint(item.effectiveConfig) ? 'direct_if_supported' as const : 'bridge' as const,
      } : {}),
      selected: item.selected,
      selectable: item.selectable,
      availability: item.availability,
      sourceKind: 'managed' as const,
      scopeKind: resolveManagedScopeKind(item),
      reasonCode: item.reasonCode,
      portability: item.portability,
      defaultSelected: item.defaultSelected,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
