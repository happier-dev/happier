import {
  inferMcpServerAuthModeV1,
  type ManagedMcpPreviewEntryV1,
  type ResolveManagedSessionMcpSelectionV1Result,
} from '@happier-dev/protocol';

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
