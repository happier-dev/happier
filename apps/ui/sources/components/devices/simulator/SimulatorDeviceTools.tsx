import * as React from 'react';
import { View } from 'react-native';
import type { SimulatorAccessibilitySnapshotV1 } from '@happier-dev/protocol/devices/simulator/accessibilityV1';
import type { SimulatorDeviceOperationKindV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import {
  SIMULATOR_PERMISSION_PRESETS,
  SIMULATOR_TEXT_SIZE_PRESETS,
  simulatorPermissionValue,
  simulatorTextSizeValue,
  type SimulatorPermissionPreset,
  type SimulatorTextSizePreset,
} from '@/sync/domains/devices/simulator/deviceSettings';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';
import type { useSimulatorDeviceOperation } from './useSimulatorDeviceOperation';

type AppliedSettings = Readonly<{
  appearance: 'light' | 'dark' | null;
  textSize: SimulatorTextSizePreset | null;
  orientation: 'portrait' | 'landscape_left' | null;
}>;

const NO_APPLIED_SETTINGS: AppliedSettings = Object.freeze({ appearance: null, textSize: null, orientation: null });

function textSizeLabel(preset: SimulatorTextSizePreset): string {
  switch (preset) {
    case 'small':
      return t('simulatorPreview.device.small');
    case 'default':
      return t('simulatorPreview.device.defaultSize');
    case 'large':
      return t('simulatorPreview.device.large');
  }
}

function permissionLabel(preset: SimulatorPermissionPreset): string {
  switch (preset) {
    case 'camera':
      return t('simulatorPreview.device.camera');
    case 'photos':
      return t('simulatorPreview.device.photos');
    case 'location':
      return t('simulatorPreview.device.locationPermission');
    case 'microphone':
      return t('simulatorPreview.device.microphone');
    case 'contacts':
      return t('simulatorPreview.device.contacts');
  }
}

function parseCoordinate(value: string, limit: number): number | null {
  const parsed = Number(value.trim());
  return value.trim().length > 0 &&
    Number.isFinite(parsed) &&
    Math.abs(parsed) <= limit
    ? parsed
    : null;
}

function parsePushPayload(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The device operations that are rare test tools: app launch and stop, links, appearance, text size,
 * orientation, location, permissions, push and the accessibility inspector. Each section exists only
 * when the selected device advertises its operation; everything runs through the device's Actions.
 * Operations are inline buttons beside the field they act on; a setting with a few named values is
 * one segmented row; a permission is chosen once, then allowed, denied or reset.
 */
export function SimulatorDeviceTools(
  props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    operations: ReturnType<typeof useSimulatorDeviceOperation>;
    testID: string;
  }>,
): React.ReactElement | null {
  const resource = props.viewModel.resource;
  const supported = props.viewModel.controls.deviceOperations;
  const { pending, run } = props.operations;
  const [appId, setAppId] = React.useState(resource?.appId ?? '');
  const [url, setUrl] = React.useState('');
  const [latitude, setLatitude] = React.useState('');
  const [longitude, setLongitude] = React.useState('');
  const [payload, setPayload] = React.useState('{"aps":{"alert":"Hello"}}');
  const [snapshot, setSnapshot] =
    React.useState<SimulatorAccessibilitySnapshotV1 | null>(null);
  const [permission, setPermission] =
    React.useState<SimulatorPermissionPreset>(SIMULATOR_PERMISSION_PRESETS[0] ?? 'camera');
  const [applied, setApplied] = React.useState<AppliedSettings>(NO_APPLIED_SETTINGS);
  if (!resource) return null;
  const simulatorId = resource.simulatorId;
  const platform = resource.platform;
  const has = (operation: SimulatorDeviceOperationKindV1) =>
    supported.includes(operation);
  const busy = pending !== null;
  const app = appId.trim();
  const latitudeValue = parseCoordinate(latitude, 90);
  const longitudeValue = parseCoordinate(longitude, 180);
  const pushPayload = parsePushPayload(payload);
  const id = (suffix: string) => `${props.testID}-${suffix}`;

  const readScreen = async () => {
    const result = await run('accessibility_snapshot', simulatorId, {
      operation: 'accessibility_snapshot',
    });
    if (result?.ok && result.snapshot) setSnapshot(result.snapshot);
  };
  const pressElement = async (identifier: string) => {
    const result = await run(`accessibility_press:${identifier}`, simulatorId, {
      operation: 'accessibility_press',
      identifier,
    });
    // The screen changed under the press: read it again so the list matches what is shown.
    if (result?.ok) await readScreen();
  };

  const appTools =
    has('app_launch') ||
    has('app_terminate') ||
    has('permission_set') ||
    has('push');
  // Settings the device only takes, never reports: a segment shows what this viewer last applied, and
  // only once the device accepted it.
  const applySetting = async <K extends keyof AppliedSettings>(
    key: K,
    value: AppliedSettings[K],
    request: Parameters<typeof run>[2],
  ) => {
    const result = await run(`${key}:${String(value)}`, simulatorId, request);
    if (result?.ok) setApplied((current) => ({ ...current, [key]: value }));
  };
  const settings = has('appearance_set') || has('text_size_set') || has('rotate');
  return (
    <>
      {appTools ? (
        <ItemGroup
          testID={id('app')}
          title={t('simulatorPreview.device.appSection')}
          description={t('simulatorPreview.device.appDescription')}
        >
          <Item
            mode="info"
            title={t('simulatorPreview.device.appId')}
            bottomElementOutsidePressable
            bottomElement={
              <View style={simulatorStreamStyles.toolField}>
                <FieldTextInput
                  testID={id('app-id')}
                  value={appId}
                  onChangeText={setAppId}
                  accessibilityLabel={t('simulatorPreview.device.appId')}
                  placeholder="com.example.app"
                  autoCapitalize="none"
                  monospace
                />
                {has('app_launch') || has('app_terminate') ? (
                  <View style={simulatorStreamStyles.toolActions}>
                    {has('app_launch') ? (
                      <ToolButton
                        testID={id('app-launch')}
                        title={t('simulatorPreview.device.launch')}
                        loading={pending === 'app_launch'}
                        disabled={busy || app.length === 0}
                        onPress={() => {
                          void run('app_launch', simulatorId, { operation: 'app_launch', appId: app });
                        }}
                      />
                    ) : null}
                    {has('app_terminate') ? (
                      <ToolButton
                        testID={id('app-terminate')}
                        title={t('simulatorPreview.device.terminate')}
                        loading={pending === 'app_terminate'}
                        disabled={busy || app.length === 0}
                        onPress={() => {
                          void run('app_terminate', simulatorId, { operation: 'app_terminate', appId: app });
                        }}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            }
          />
        </ItemGroup>
      ) : null}
      {has('open_url') ? (
        <ItemGroup testID={id('link')} title={t('simulatorPreview.device.linkSection')}>
          <Item
            mode="info"
            title={t('simulatorPreview.device.url')}
            bottomElementOutsidePressable
            bottomElement={
              <View style={simulatorStreamStyles.toolFieldRow}>
                <View style={simulatorStreamStyles.toolFieldGrow}>
                  <FieldTextInput
                    testID={id('url')}
                    value={url}
                    onChangeText={setUrl}
                    accessibilityLabel={t('simulatorPreview.device.url')}
                    placeholder="myapp://home"
                    autoCapitalize="none"
                    keyboardType="url"
                    monospace
                  />
                </View>
                <ToolButton
                  testID={id('open-url')}
                  title={t('simulatorPreview.device.open')}
                  loading={pending === 'open_url'}
                  disabled={busy || url.trim().length === 0}
                  onPress={() => {
                    void run('open_url', simulatorId, { operation: 'open_url', url: url.trim() });
                  }}
                />
              </View>
            }
          />
        </ItemGroup>
      ) : null}
      {settings ? (
        <ItemGroup testID={id('settings')} title={t('simulatorPreview.device.settingsSection')}>
          {has('appearance_set') ? (
            <SegmentedChoiceItem
              testID={id('appearance')}
              testIDPrefix={id('appearance')}
              title={t('simulatorPreview.device.appearance')}
              compact
              disabled={busy}
              value={applied.appearance}
              options={[
                { id: 'light', label: t('simulatorPreview.device.light') },
                { id: 'dark', label: t('simulatorPreview.device.dark') },
              ]}
              onChange={(appearance) => {
                void applySetting('appearance', appearance, { operation: 'appearance_set', appearance });
              }}
            />
          ) : null}
          {has('text_size_set') ? (
            <SegmentedChoiceItem
              testID={id('text-size')}
              testIDPrefix={id('text-size')}
              title={t('simulatorPreview.device.textSize')}
              compact
              disabled={busy}
              value={applied.textSize}
              options={SIMULATOR_TEXT_SIZE_PRESETS.map((preset) => ({ id: preset, label: textSizeLabel(preset) }))}
              onChange={(preset) => {
                void applySetting('textSize', preset, {
                  operation: 'text_size_set',
                  size: simulatorTextSizeValue(platform, preset),
                });
              }}
            />
          ) : null}
          {has('rotate') ? (
            <SegmentedChoiceItem
              testID={id('orientation')}
              testIDPrefix={id('orientation')}
              title={t('simulatorPreview.device.orientation')}
              compact
              disabled={busy}
              value={applied.orientation}
              options={[
                { id: 'portrait', label: t('simulatorPreview.device.portrait') },
                { id: 'landscape_left', label: t('simulatorPreview.device.landscape') },
              ]}
              onChange={(orientation) => {
                void applySetting('orientation', orientation, { operation: 'rotate', orientation });
              }}
            />
          ) : null}
        </ItemGroup>
      ) : null}
      {has('location_set') ? (
        <ItemGroup testID={id('location')} title={t('simulatorPreview.device.location')}>
          <Item
            mode="info"
            title={`${t('simulatorPreview.device.latitude')} · ${t('simulatorPreview.device.longitude')}`}
            bottomElementOutsidePressable
            bottomElement={
              <View style={simulatorStreamStyles.toolField}>
                <View style={simulatorStreamStyles.toolFieldRow}>
                  <View style={simulatorStreamStyles.toolFieldGrow}>
                    <FieldTextInput
                      testID={id('latitude')}
                      value={latitude}
                      onChangeText={setLatitude}
                      accessibilityLabel={t('simulatorPreview.device.latitude')}
                      placeholder="48.8566"
                      inputMode="decimal"
                    />
                  </View>
                  <View style={simulatorStreamStyles.toolFieldGrow}>
                    <FieldTextInput
                      testID={id('longitude')}
                      value={longitude}
                      onChangeText={setLongitude}
                      accessibilityLabel={t('simulatorPreview.device.longitude')}
                      placeholder="2.3522"
                      inputMode="decimal"
                    />
                  </View>
                </View>
                <View style={simulatorStreamStyles.toolActions}>
                  <ToolButton
                    testID={id('location-set')}
                    title={t('simulatorPreview.device.setLocation')}
                    loading={pending === 'location_set'}
                    disabled={busy || latitudeValue === null || longitudeValue === null}
                    onPress={() => {
                      if (latitudeValue === null || longitudeValue === null) return;
                      void run('location_set', simulatorId, {
                        operation: 'location_set',
                        latitude: latitudeValue,
                        longitude: longitudeValue,
                      });
                    }}
                  />
                  {has('location_clear') ? (
                    <ToolButton
                      testID={id('location-clear')}
                      title={t('simulatorPreview.device.clearLocation')}
                      loading={pending === 'location_clear'}
                      disabled={busy}
                      onPress={() => {
                        void run('location_clear', simulatorId, { operation: 'location_clear' });
                      }}
                    />
                  ) : null}
                </View>
              </View>
            }
          />
        </ItemGroup>
      ) : null}
      {has('permission_set') ? (
        <ItemGroup
          testID={id('permissions')}
          title={t('simulatorPreview.device.permissions')}
          description={
            app.length > 0
              ? t('simulatorPreview.device.permissionsDescription')
              : t('simulatorPreview.device.needAppId')
          }
        >
          <Item
            mode="info"
            title={t('simulatorPreview.device.permission')}
            bottomElementOutsidePressable
            bottomElement={
              <View style={simulatorStreamStyles.toolField}>
                <ValueFieldSelect
                  testID={id('permission')}
                  label={t('simulatorPreview.device.permission')}
                  items={SIMULATOR_PERMISSION_PRESETS.map((preset) => ({ id: preset, title: permissionLabel(preset) }))}
                  selectedId={permission}
                  onSelect={(next) => {
                    const preset = SIMULATOR_PERMISSION_PRESETS.find((entry) => entry === next);
                    if (preset) setPermission(preset);
                  }}
                  fill
                />
                <View style={simulatorStreamStyles.toolActions}>
                  {(['grant', 'revoke', 'reset'] as const).map((value) => (
                    <ToolButton
                      key={value}
                      testID={id(`permission-${value}`)}
                      title={
                        value === 'grant'
                          ? t('simulatorPreview.device.allow')
                          : value === 'revoke'
                            ? t('simulatorPreview.device.deny')
                            : t('simulatorPreview.device.reset')
                      }
                      loading={pending === `permission:${permission}:${value}`}
                      disabled={busy || app.length === 0}
                      onPress={() => {
                        void run(`permission:${permission}:${value}`, simulatorId, {
                          operation: 'permission_set',
                          appId: app,
                          permission: simulatorPermissionValue(platform, permission),
                          value,
                        });
                      }}
                    />
                  ))}
                </View>
              </View>
            }
          />
        </ItemGroup>
      ) : null}
      {has('push') && platform === 'ios' ? (
        <ItemGroup
          testID={id('push')}
          title={t('simulatorPreview.device.push')}
          description={
            app.length > 0
              ? t('simulatorPreview.device.pushDescription')
              : t('simulatorPreview.device.needAppId')
          }
        >
          <Item
            mode="info"
            title={t('simulatorPreview.device.payload')}
            bottomElementOutsidePressable
            bottomElement={
              <View style={simulatorStreamStyles.toolField}>
                <FieldTextInput
                  testID={id('push-payload')}
                  value={payload}
                  onChangeText={setPayload}
                  accessibilityLabel={t('simulatorPreview.device.payload')}
                  multiline
                  monospace
                  autoCapitalize="none"
                  error={pushPayload ? null : t('simulatorPreview.device.invalidJson')}
                />
                <View style={simulatorStreamStyles.toolActions}>
                  <ToolButton
                    testID={id('push-send')}
                    title={t('simulatorPreview.device.send')}
                    loading={pending === 'push'}
                    disabled={busy || app.length === 0 || pushPayload === null}
                    onPress={() => {
                      if (!pushPayload) return;
                      void run('push', simulatorId, { operation: 'push', appId: app, payload: pushPayload });
                    }}
                  />
                </View>
              </View>
            }
          />
        </ItemGroup>
      ) : null}
      {has('accessibility_snapshot') ? (
        <ItemGroup
          testID={id('accessibility')}
          title={t('simulatorPreview.device.accessibility')}
          description={
            snapshot?.truncated
              ? t('simulatorPreview.device.truncated')
              : t('simulatorPreview.device.accessibilityDescription')
          }
          action={
            <ToolButton
              testID={id('accessibility-read')}
              title={t('simulatorPreview.device.readScreen')}
              loading={pending === 'accessibility_snapshot'}
              disabled={busy}
              onPress={() => {
                void readScreen();
              }}
            />
          }
        >
          {snapshot && snapshot.nodes.length === 0 ? (
            <Item mode="info" title={t('simulatorPreview.device.noElements')} />
          ) : null}
          {/* The producer bounds the snapshot (it says when it truncated), so its nodes render as rows. */}
          {snapshot?.nodes.map((node) => {
            const identifier = node.identifier;
            return (
              <Item
                key={node.index}
                mode="info"
                testID={id(`accessibility-node:${node.index}`)}
                title={node.label ?? identifier ?? node.type}
                subtitle={[node.type, identifier].filter(Boolean).join(' · ')}
                rightElement={
                  identifier &&
                  has('accessibility_press') &&
                  node.enabled !== false ? (
                    <RoundButton
                      size="mini"
                      display="secondary"
                      testID={id(`accessibility-press:${identifier}`)}
                      title={t('simulatorPreview.device.press')}
                      loading={pending === `accessibility_press:${identifier}`}
                      disabled={busy}
                      onPress={() => {
                        void pressElement(identifier);
                      }}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </ItemGroup>
      ) : null}
    </>
  );
}

/** A tool's operation: a quiet inline button, the panel's one button shape. */
function ToolButton(props: Readonly<{
  testID: string;
  title: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}>): React.ReactElement {
  return (
    <RoundButton
      size="small"
      display="secondary"
      testID={props.testID}
      title={props.title}
      loading={props.loading}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}
