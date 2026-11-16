import * as React from 'react';
import { View } from 'react-native';
import type { SimulatorAccessibilitySnapshotV1 } from '@happier-dev/protocol/devices/simulator/accessibilityV1';
import type { SimulatorDeviceOperationKindV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
              <FieldTextInput
                testID={id('app-id')}
                value={appId}
                onChangeText={setAppId}
                accessibilityLabel={t('simulatorPreview.device.appId')}
                placeholder="com.example.app"
                autoCapitalize="none"
                monospace
              />
            }
          />
          {has('app_launch') ? (
            <Item
              testID={id('app-launch')}
              title={t('simulatorPreview.device.launch')}
              showChevron={false}
              disabled={busy || app.length === 0}
              onPress={() => {
                void run('app_launch', simulatorId, {
                  operation: 'app_launch',
                  appId: app,
                });
              }}
            />
          ) : null}
          {has('app_terminate') ? (
            <Item
              testID={id('app-terminate')}
              title={t('simulatorPreview.device.terminate')}
              showChevron={false}
              disabled={busy || app.length === 0}
              onPress={() => {
                void run('app_terminate', simulatorId, {
                  operation: 'app_terminate',
                  appId: app,
                });
              }}
            />
          ) : null}
        </ItemGroup>
      ) : null}
      {has('open_url') ? (
        <ItemGroup
          testID={id('link')}
          title={t('simulatorPreview.device.linkSection')}
        >
          <Item
            mode="info"
            title={t('simulatorPreview.device.url')}
            bottomElementOutsidePressable
            bottomElement={
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
            }
          />
          <Item
            testID={id('open-url')}
            title={t('simulatorPreview.device.open')}
            showChevron={false}
            disabled={busy || url.trim().length === 0}
            onPress={() => {
              void run('open_url', simulatorId, {
                operation: 'open_url',
                url: url.trim(),
              });
            }}
          />
        </ItemGroup>
      ) : null}
      {has('appearance_set') ? (
        <ItemGroup
          testID={id('appearance')}
          title={t('simulatorPreview.device.appearance')}
        >
          {(['light', 'dark'] as const).map((appearance) => (
            <Item
              key={appearance}
              testID={id(`appearance-${appearance}`)}
              showChevron={false}
              disabled={busy}
              title={
                appearance === 'light'
                  ? t('simulatorPreview.device.light')
                  : t('simulatorPreview.device.dark')
              }
              onPress={() => {
                void run('appearance_set', simulatorId, {
                  operation: 'appearance_set',
                  appearance,
                });
              }}
            />
          ))}
        </ItemGroup>
      ) : null}
      {has('text_size_set') ? (
        <ItemGroup
          testID={id('text-size')}
          title={t('simulatorPreview.device.textSize')}
        >
          {SIMULATOR_TEXT_SIZE_PRESETS.map((preset) => (
            <Item
              key={preset}
              testID={id(`text-size-${preset}`)}
              showChevron={false}
              disabled={busy}
              title={textSizeLabel(preset)}
              onPress={() => {
                void run('text_size_set', simulatorId, {
                  operation: 'text_size_set',
                  size: simulatorTextSizeValue(platform, preset),
                });
              }}
            />
          ))}
        </ItemGroup>
      ) : null}
      {has('rotate') ? (
        <ItemGroup
          testID={id('orientation')}
          title={t('simulatorPreview.device.orientation')}
        >
          {(['portrait', 'landscape_left'] as const).map((orientation) => (
            <Item
              key={orientation}
              testID={id(`orientation-${orientation}`)}
              showChevron={false}
              disabled={busy}
              title={
                orientation === 'portrait'
                  ? t('simulatorPreview.device.portrait')
                  : t('simulatorPreview.device.landscape')
              }
              onPress={() => {
                void run('rotate', simulatorId, {
                  operation: 'rotate',
                  orientation,
                });
              }}
            />
          ))}
        </ItemGroup>
      ) : null}
      {has('location_set') ? (
        <ItemGroup
          testID={id('location')}
          title={t('simulatorPreview.device.location')}
        >
          <Item
            mode="info"
            title={t('simulatorPreview.device.latitude')}
            bottomElementOutsidePressable
            bottomElement={
              <FieldTextInput
                testID={id('latitude')}
                value={latitude}
                onChangeText={setLatitude}
                accessibilityLabel={t('simulatorPreview.device.latitude')}
                placeholder="48.8566"
                inputMode="decimal"
              />
            }
          />
          <Item
            mode="info"
            title={t('simulatorPreview.device.longitude')}
            bottomElementOutsidePressable
            bottomElement={
              <FieldTextInput
                testID={id('longitude')}
                value={longitude}
                onChangeText={setLongitude}
                accessibilityLabel={t('simulatorPreview.device.longitude')}
                placeholder="2.3522"
                inputMode="decimal"
              />
            }
          />
          <Item
            testID={id('location-set')}
            title={t('simulatorPreview.device.setLocation')}
            showChevron={false}
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
            <Item
              testID={id('location-clear')}
              title={t('simulatorPreview.device.clearLocation')}
              showChevron={false}
              disabled={busy}
              onPress={() => {
                void run('location_clear', simulatorId, {
                  operation: 'location_clear',
                });
              }}
            />
          ) : null}
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
          {SIMULATOR_PERMISSION_PRESETS.map((preset) => (
            <Item
              key={preset}
              mode="info"
              testID={id(`permission-${preset}`)}
              title={permissionLabel(preset)}
              bottomElementOutsidePressable
              bottomElement={
                <View style={simulatorStreamStyles.inlineActions}>
                  {(['grant', 'revoke', 'reset'] as const).map((value) => (
                    <RoundButton
                      key={value}
                      size="mini"
                      display="secondary"
                      testID={id(`permission-${preset}-${value}`)}
                      title={
                        value === 'grant'
                          ? t('simulatorPreview.device.allow')
                          : value === 'revoke'
                            ? t('simulatorPreview.device.deny')
                            : t('simulatorPreview.device.reset')
                      }
                      disabled={busy || app.length === 0}
                      onPress={() => {
                        void run(`permission:${preset}:${value}`, simulatorId, {
                          operation: 'permission_set',
                          appId: app,
                          permission: simulatorPermissionValue(
                            platform,
                            preset,
                          ),
                          value,
                        });
                      }}
                    />
                  ))}
                </View>
              }
            />
          ))}
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
              <FieldTextInput
                testID={id('push-payload')}
                value={payload}
                onChangeText={setPayload}
                accessibilityLabel={t('simulatorPreview.device.payload')}
                multiline
                monospace
                autoCapitalize="none"
                error={
                  pushPayload ? null : t('simulatorPreview.device.invalidJson')
                }
              />
            }
          />
          <Item
            testID={id('push-send')}
            title={t('simulatorPreview.device.send')}
            showChevron={false}
            disabled={busy || app.length === 0 || pushPayload === null}
            onPress={() => {
              if (!pushPayload) return;
              void run('push', simulatorId, {
                operation: 'push',
                appId: app,
                payload: pushPayload,
              });
            }}
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
        >
          <Item
            testID={id('accessibility-read')}
            title={t('simulatorPreview.device.readScreen')}
            showChevron={false}
            disabled={busy}
            onPress={() => {
              void readScreen();
            }}
          />
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
