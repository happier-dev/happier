import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  listActionSpecs,
  type ActionId,
  type ActionSurfaces,
  type ActionUiPlacement,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { useSettingMutable } from '@/sync/domains/state/storage';

type ActionSettingsEntry = Readonly<{
  enabled?: boolean;
  enabledPlacements: readonly ActionUiPlacement[];
  disabledSurfaces: readonly (keyof ActionSurfaces)[];
  disabledPlacements: readonly ActionUiPlacement[];
}>;

function normalizeEntry(raw: unknown): ActionSettingsEntry {
  const parsed = ActionsSettingsV1Schema.safeParse({ v: 1, actions: { x: raw } });
  if (parsed.success) {
    const entry = (parsed.data.actions as any)?.x ?? null;
    if (entry) return entry as any;
  }
  return { enabled: undefined, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [] };
}

function uniqSorted<T extends string>(values: readonly T[]): readonly T[] {
  const out = Array.from(new Set(values.map((v) => String(v) as T)));
  out.sort((a, b) => String(a).localeCompare(String(b)));
  return out;
}

const SURFACE_LABELS: Record<keyof ActionSurfaces, string> = {
  ui_button: 'UI buttons',
  ui_slash_command: 'Slash commands',
  voice_tool: 'Voice tools',
  voice_action_block: 'Voice action blocks',
  mcp: 'MCP',
  session_control_cli: 'Session control CLI',
};

const SURFACE_ICONS: Record<keyof ActionSurfaces, React.ComponentProps<typeof Ionicons>['name']> = {
  ui_button: 'flash-outline',
  ui_slash_command: 'code-slash-outline',
  voice_tool: 'mic-outline',
  voice_action_block: 'chatbubble-ellipses-outline',
  mcp: 'cube-outline',
  session_control_cli: 'terminal-outline',
};

const PLACEMENT_LABELS: Record<ActionUiPlacement, string> = {
  agent_input_chips: 'Agent input chips',
  session_header: 'Session header',
  session_action_menu: 'Session action menu',
  command_palette: 'Command palette',
  slash_command: 'Slash command',
  voice_panel: 'Voice panel',
  session_info: 'Session info',
  run_list: 'Runs list',
  run_card: 'Run card',
};

const PLACEMENT_ICONS: Record<ActionUiPlacement, React.ComponentProps<typeof Ionicons>['name']> = {
  agent_input_chips: 'add-circle-outline',
  session_header: 'albums-outline',
  session_action_menu: 'ellipsis-horizontal',
  command_palette: 'search-outline',
  slash_command: 'code-slash-outline',
  voice_panel: 'mic-outline',
  session_info: 'information-circle-outline',
  run_list: 'play-outline',
  run_card: 'document-text-outline',
};

export const ActionsSettingsView = React.memo(function ActionsSettingsView() {
  const [raw, setRaw] = useSettingMutable('actionsSettingsV1');

  const settings = React.useMemo(() => {
    const parsed = ActionsSettingsV1Schema.safeParse(raw ?? null);
    return parsed.success ? parsed.data : { v: 1 as const, actions: {} as Record<ActionId, any> };
  }, [raw]);

  const setSettings = React.useCallback(
    (next: any) => {
      const parsed = ActionsSettingsV1Schema.safeParse(next);
      setRaw(parsed.success ? (parsed.data as any) : ({ v: 1, actions: {} } as any));
    },
    [setRaw],
  );

  const specs = React.useMemo(() => {
    return listActionSpecs()
      .slice()
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  }, []);

  return (
    <ItemList style={{ paddingTop: 0 }}>
      <ItemGroup title="Actions">
        <Item
          title="About"
          subtitle="Enable or disable actions globally, per surface (UI/voice/MCP), and per placement (where they appear in the UI). Disabled actions are fail-closed at runtime."
          icon={<Ionicons name="information-circle-outline" size={29} color="#8E8E93" />}
          showChevron={false}
        />
      </ItemGroup>

      {specs.map((spec) => {
        const entry = normalizeEntry((settings.actions as any)?.[spec.id]);
        const globallyEnabled = entry.enabled !== false;

        const supportedSurfaces = (Object.keys(spec.surfaces ?? {}) as Array<keyof ActionSurfaces>).filter((k) =>
          Boolean((spec.surfaces as any)?.[k] === true),
        );

        const supportedPlacements = Array.isArray((spec as any).placements)
          ? ((spec as any).placements as ActionUiPlacement[])
          : [];

        const updateEntry = (nextEntry: ActionSettingsEntry) => {
          const merged = {
            ...settings,
            actions: {
              ...(settings.actions as any),
              [spec.id]: {
                enabled: nextEntry.enabled,
                enabledPlacements: uniqSorted(nextEntry.enabledPlacements as any),
                disabledSurfaces: uniqSorted(nextEntry.disabledSurfaces as any),
                disabledPlacements: uniqSorted(nextEntry.disabledPlacements as any),
              },
            },
          };
          setSettings(merged);
        };

        const toggleGlobal = () => {
          updateEntry({
            ...entry,
            enabled: globallyEnabled ? false : true,
          });
        };

        const toggleSurface = (surface: keyof ActionSurfaces) => {
          const set = new Set(entry.disabledSurfaces as readonly string[]);
          if (set.has(surface)) set.delete(surface);
          else set.add(surface);
          updateEntry({ ...entry, disabledSurfaces: Array.from(set) as any });
        };

        const togglePlacement = (placement: ActionUiPlacement) => {
          const optInPlacements = new Set<ActionUiPlacement>(['agent_input_chips']);
          if (optInPlacements.has(placement)) {
            const enabledSet = new Set(entry.enabledPlacements as readonly string[]);
            const disabledSet = new Set(entry.disabledPlacements as readonly string[]);
            const isEnabled = enabledSet.has(placement);
            if (isEnabled) {
              enabledSet.delete(placement);
            } else {
              enabledSet.add(placement);
              disabledSet.delete(placement);
            }
            updateEntry({ ...entry, enabledPlacements: Array.from(enabledSet) as any, disabledPlacements: Array.from(disabledSet) as any });
            return;
          }

          const set = new Set(entry.disabledPlacements as readonly string[]);
          if (set.has(placement)) set.delete(placement);
          else set.add(placement);
          updateEntry({ ...entry, disabledPlacements: Array.from(set) as any });
        };

        const effectiveEnabled = isActionEnabledByActionsSettings(spec.id as any, settings as any);
        const statusLabel = effectiveEnabled ? 'Enabled' : 'Disabled';

        return (
          <ItemGroup key={spec.id} title={spec.title} footer={spec.id}>
            <Item
              title="Enabled"
              subtitle={statusLabel}
              icon={
                <Ionicons
                  name={effectiveEnabled ? 'flash-outline' : 'flash-off-outline'}
                  size={29}
                  color={effectiveEnabled ? '#34C759' : '#FF3B30'}
                />
              }
              rightElement={<Switch value={globallyEnabled} onValueChange={toggleGlobal} />}
              showChevron={false}
              onPress={toggleGlobal}
            />

            {supportedSurfaces.map((surface) => {
              const isEnabledOnSurface = isActionEnabledByActionsSettings(spec.id as any, settings as any, { surface } as any);
              return (
                <Item
                  key={`surface:${surface}`}
                  title={SURFACE_LABELS[surface] ?? String(surface)}
                  subtitle={isEnabledOnSurface ? 'Enabled' : 'Disabled'}
                  icon={<Ionicons name={SURFACE_ICONS[surface] ?? 'options-outline'} size={29} color="#8E8E93" />}
                  rightElement={<Switch value={isEnabledOnSurface} onValueChange={() => toggleSurface(surface)} />}
                  showChevron={false}
                  onPress={() => toggleSurface(surface)}
                />
              );
            })}

            {supportedPlacements.map((placement) => {
              const isEnabledInPlacement = isActionEnabledByActionsSettings(spec.id as any, settings as any, { placement } as any);
              return (
                <Item
                  key={`placement:${placement}`}
                  title={PLACEMENT_LABELS[placement] ?? String(placement)}
                  subtitle={isEnabledInPlacement ? 'Enabled' : 'Disabled'}
                  icon={<Ionicons name={PLACEMENT_ICONS[placement] ?? 'options-outline'} size={29} color="#8E8E93" />}
                  rightElement={<Switch value={isEnabledInPlacement} onValueChange={() => togglePlacement(placement)} />}
                  showChevron={false}
                  onPress={() => togglePlacement(placement)}
                />
              );
            })}
          </ItemGroup>
        );
      })}
    </ItemList>
  );
});
