import type { McpServersSettingsV1, McpServerCatalogEntryV1 } from './settingsV1.js';
import { SessionMcpSelectionV1Schema, type SessionMcpSelectionV1 } from './sessionSelectionV1.js';
import {
  resolveApplicableServerBindingV1,
  resolvePortableServerBindingV1,
} from './resolveServerBindingV1.js';
import type { ResolvedMcpServerV1 } from './resolveEffectiveServersV1.js';

export type ManagedSessionMcpAvailabilityV1 = 'active' | 'available' | 'unavailable';
export type ManagedSessionMcpReasonCodeV1 =
  | 'active_by_default'
  | 'forced_included'
  | 'forced_excluded'
  | 'managed_servers_disabled'
  | 'binding_disabled'
  | 'available_portable'
  | 'not_portable';
export type ManagedSessionMcpPortabilityV1 = 'portable' | 'machine_scoped';

export type ManagedSessionMcpSelectionItemV1 = Readonly<{
  serverId: string;
  name: string;
  title?: string;
  transport: McpServerCatalogEntryV1['transport'];
  bindingId: string | null;
  bindingTargetKind: 'allMachines' | 'machine' | 'workspace' | null;
  selected: boolean;
  selectable: boolean;
  availability: ManagedSessionMcpAvailabilityV1;
  reasonCode: ManagedSessionMcpReasonCodeV1;
  portability: ManagedSessionMcpPortabilityV1;
  defaultSelected: boolean;
  effectiveConfig: McpServerCatalogEntryV1;
}>;

export type ResolveManagedSessionMcpSelectionV1Result = Readonly<{
  strictMode: boolean;
  selection: SessionMcpSelectionV1;
  itemsByName: Readonly<Record<string, ManagedSessionMcpSelectionItemV1>>;
  selectedServersByName: Readonly<Record<string, ResolvedMcpServerV1>>;
}>;

export function resolveManagedSessionMcpSelectionV1(
  settings: McpServersSettingsV1,
  params: Readonly<{
    machineId: string;
    directory: string;
    selection?: SessionMcpSelectionV1 | null | undefined;
    normalizePath?: (value: string) => string;
  }>,
): ResolveManagedSessionMcpSelectionV1Result {
  const selection = SessionMcpSelectionV1Schema.parse(params.selection ?? {});
  const forcedIncludes = new Set(selection.forceIncludeServerIds);
  const forcedExcludes = new Set(selection.forceExcludeServerIds);

  const itemsByName: Record<string, ManagedSessionMcpSelectionItemV1> = {};
  const selectedServersByName: Record<string, ResolvedMcpServerV1> = {};

  for (const server of settings.servers) {
    const bindings = settings.bindings.filter((binding) => binding.serverId === server.id);
    const applicable = resolveApplicableServerBindingV1({
      server,
      bindings,
      machineId: params.machineId,
      directory: params.directory,
      normalizePath: params.normalizePath,
    });
    const portable = resolvePortableServerBindingV1({ server, bindings });

    const hasApplicableBinding = applicable.binding !== null;
    const portability: ManagedSessionMcpPortabilityV1 = portable ? 'portable' : 'machine_scoped';
    const selectable = hasApplicableBinding || portable !== null;
    const defaultSelected = selection.managedServersEnabled && applicable.enabled;
    const forceExcluded = forcedExcludes.has(server.id);
    const forceIncluded = forcedIncludes.has(server.id) && !forceExcluded && selectable;

    const selectedResolution = forceExcluded
      ? null
      : forceIncluded
        ? applicable.binding
          ? applicable
          : portable
        : defaultSelected
          ? applicable
          : null;

    const selected = selectedResolution !== null;
    let availability: ManagedSessionMcpAvailabilityV1;
    let reasonCode: ManagedSessionMcpReasonCodeV1;

    if (selected && forceIncluded) {
      availability = 'active';
      reasonCode = 'forced_included';
    } else if (selected) {
      availability = 'active';
      reasonCode = 'active_by_default';
    } else if (forceExcluded) {
      availability = selectable ? 'available' : 'unavailable';
      reasonCode = 'forced_excluded';
    } else if (!selection.managedServersEnabled && hasApplicableBinding) {
      availability = 'available';
      reasonCode = 'managed_servers_disabled';
    } else if (hasApplicableBinding) {
      availability = 'available';
      reasonCode = 'binding_disabled';
    } else if (portable) {
      availability = 'available';
      reasonCode = 'available_portable';
    } else {
      availability = 'unavailable';
      reasonCode = 'not_portable';
    }

    const effectiveConfig = selectedResolution?.config ?? applicable.config ?? portable?.config ?? server;
    const bindingId = selectedResolution?.bindingId ?? applicable.bindingId ?? portable?.bindingId ?? null;
    const bindingTargetKind = selectedResolution?.bindingTargetKind ?? applicable.bindingTargetKind ?? portable?.bindingTargetKind ?? null;

    itemsByName[server.name] = {
      serverId: server.id,
      name: server.name,
      title: server.title,
      transport: server.transport,
      bindingId,
      bindingTargetKind,
      selected,
      selectable,
      availability,
      reasonCode,
      portability,
      defaultSelected,
      effectiveConfig,
    };

    if (selectedResolution) {
      selectedServersByName[server.name] = {
        serverId: server.id,
        name: server.name,
        bindingId: selectedResolution.bindingId,
        enabled: true,
        config: selectedResolution.config,
      };
    }
  }

  return {
    strictMode: settings.strictMode,
    selection,
    itemsByName,
    selectedServersByName,
  };
}
