import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import {
  HappierCapabilityAddBody,
  HappierCapabilityAddDetailAction,
  type HappierCapabilityAddBodyProps,
  type HappierCapabilityAddConfig,
  type HappierCapabilityAddDetailFooter,
  type HappierCapabilityAddFound,
  type HappierCapabilityAddHost,
  type HappierCapabilityAddLabels,
  type HappierCapabilityAddLevel,
  type HappierCapabilityAddMode,
} from '../presentation/capabilities/CapabilityAddBody.js';
import { resolveHappierViewportClass } from '../presentation/layout/viewportClass.js';
import { Button } from './Button.js';
import { Collection } from './Collection.js';
import { Select } from './Form.js';
import { Banner } from './Foundation.js';
import type { IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Text } from './Text.js';

const ADD_KEY = 'happier.plugin-ui.capability.add';

export type CapabilityAddMode = HappierCapabilityAddMode<IconName>;
export type CapabilityAddConfig<Item> = HappierCapabilityAddConfig<Item, IconName>;
export type CapabilityAddFound<Found> = HappierCapabilityAddFound<Found>;
export type CapabilityAddDetailFooter = HappierCapabilityAddDetailFooter;
export type CapabilityAddLevel = HappierCapabilityAddLevel;
export type CapabilityAddBodyProps<Item> = Pick<HappierCapabilityAddBodyProps<Item, IconName>,
  'config' | 'onClose' | 'onLevelChange' | 'renderLayout'>;

const PUBLIC_ADD_SLOTS: HappierCapabilityAddHost<IconName> = {
  Collection,
  ModeTabs: ({ modes, activeKey, onSelect, accessibilityLabel, testID }) => (
    <Select
      testID={`${testID}:modes`}
      label={accessibilityLabel}
      presentation="segmented"
      options={modes.map((mode) => ({ value: mode.key, label: mode.label }))}
      value={activeKey}
      onChange={(next) => onSelect(String(next))}
    />
  ),
  Button: ({ title, display, loading, disabled, onPress, testID }) => (
    <Button
      title={title}
      variant={display}
      {...(loading === undefined ? {} : { busy: loading })}
      {...(disabled === undefined ? {} : { disabled })}
      onPress={onPress}
      testID={testID}
    />
  ),
  SourceFailure: ({ title, retryLabel, onRetry, retryTestID, testID }) => (
    <Banner
      tone="warning"
      presentation="strip"
      title={title}
      action={<Button variant="secondary" size="small" title={retryLabel} onPress={onRetry} testID={retryTestID} />}
      testID={testID}
    />
  ),
  ErrorText: ({ children, testID }) => (
    <Text variant="meta" tone="danger" testID={testID}>
      {children}
    </Text>
  ),
};

/**
 * The Add body for a plugin's own installable things, inside the plugin's own page or sheet: the ways to add as tabs,
 * the catalog list with details beside it (pushed on a phone), the item's action under its identity and the registry selector — the same
 * body Happier's Add a skill, Add a server and Add an agent dialogs draw. The frame and its header stay yours.
 */
/** Place the open item's action under its identity and purpose in your details. */
export const CapabilityAddDetailAction = HappierCapabilityAddDetailAction;

export function CapabilityAddBody<Item>(props: CapabilityAddBodyProps<Item>): React.ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const { width, height } = useWindowDimensions();
  const labels = React.useMemo<HappierCapabilityAddLabels>(
    () => ({
      modesLabel: translate(`${ADD_KEY}.modesLabel`, 'Ways to add'),
      searchLabel: translate(`${ADD_KEY}.searchLabel`, 'Search'),
      retry: translate(`${ADD_KEY}.retry`, 'Retry'),
      closeDetails: translate(`${ADD_KEY}.closeDetails`, 'Close details'),
      added: translate(`${ADD_KEY}.added`, 'Added'),
      done: translate(`${ADD_KEY}.done`, 'Done'),
      addFailed: translate(`${ADD_KEY}.addFailed`, 'Couldn’t add it. Try again.'),
    }),
    [translate],
  );
  return (
    <HappierCapabilityAddBody
      config={props.config}
      onClose={props.onClose}
      {...(props.onLevelChange === undefined ? {} : { onLevelChange: props.onLevelChange })}
      {...(props.renderLayout === undefined ? {} : { renderLayout: props.renderLayout })}
      phone={resolveHappierViewportClass({ width, height }) === 'compact'}
      labels={labels}
      host={PUBLIC_ADD_SLOTS}
      hairlineColor={theme.colors.border}
    />
  );
}
