import * as React from 'react';

import { HappierCollectionSpaceIcon } from '../presentation/collection/CollectionSpaceIcon.js';
import type { IconName } from './Icon.js';
import { PluginUiIconGlyph } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type CollectionSpaceIconProps = Readonly<{
  icon: Readonly<{ kind: 'icon'; name: IconName }> | Readonly<{ kind: 'project'; favicon?: Readonly<{ uri: string }> | null }>;
  size: number;
  testID?: string;
}>;

/** Render already-held Space identity; the caller owns Project lookup and favicon acquisition. */
export function CollectionSpaceIcon(props: CollectionSpaceIconProps) {
  const theme = usePluginTheme();
  const glyph = (name: IconName, testID?: string) => <PluginUiIconGlyph name={name} size={props.size} color={theme.colors.secondaryText} testID={testID} />;
  return <HappierCollectionSpaceIcon size={props.size} testID={props.testID}
    mark={props.icon.kind === 'icon'
      ? { kind: 'icon', glyph: glyph(props.icon.name, props.testID) }
      : { kind: 'project', favicon: props.icon.favicon ?? null, fallback: glyph('file') }} />;
}
