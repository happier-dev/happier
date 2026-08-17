import type { ReactElement } from 'react';

import { useHappierUiPlatform } from '../environment/context.js';
import type { PluginUiResourceReference } from '../hostApi/resourceStore.js';
import { usePluginResource } from '../hostApi/index.js';
import { HappierBrandMark, HappierImage, type HappierImageSize } from '../presentation/content/Image.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type ImageProps = Readonly<{
  /** An admitted packaged image/png Resource. Remote/data URLs are not accepted. */
  resource: PluginUiResourceReference;
  size?: HappierImageSize;
  accessibilityLabel?: string;
  fallback?: string;
  testID?: string;
}>;

/** Bounded package-Resource image; never a downloader or persistent byte cache. */
export function Image({ resource, size = 'medium', accessibilityLabel, fallback = '•', testID }: ImageProps): ReactElement {
  const { resource: snapshot } = usePluginResource(resource);
  const theme = usePluginTheme();
  const content = snapshot.value;
  return (
    <HappierImage
      bytes={content?.contentType === 'image/png' ? content.bytes : undefined}
      size={size}
      accessibilityLabel={accessibilityLabel}
      fallback={fallback}
      theme={theme}
      testID={testID}
    />
  );
}

export type BrandMarkProps = Readonly<{
  /** Exact host-known package target; omitted preserves the mounted plugin brand. */
  pluginId?: string;
  size?: ImageProps['size'];
  showName?: boolean;
  /** An adjacent host-owned label already supplies the one canonical name. */
  externallyLabelled?: boolean;
  testID?: string;
}>;

/**
 * Returns an exact-target canonical-name reader through the mounted
 * host-private presentation capability. It cannot enumerate packages or
 * resolve IDs itself.
 */
export function usePluginBrandDisplayNameResolver(): (pluginId?: string) => string | undefined {
  const presentationHost = useOptionalPluginUiPresentationHost();
  return (pluginId?: string) => {
    if (pluginId !== undefined) {
      const targetPluginId = pluginId.trim();
      return targetPluginId
        ? presentationHost?.resolveBrandDisplayName?.(targetPluginId)
        : undefined;
    }
    return presentationHost?.brand?.displayName;
  };
}

/** Reads one canonical package name without exposing package enumeration. */
export function usePluginBrandDisplayName(pluginId?: string): string | undefined {
  return usePluginBrandDisplayNameResolver()(pluginId);
}

/**
 * Consume the manifest-owned brand for the mounted plugin. Brand identity is
 * intentionally not an author prop: `manifest.brand.iconResourceId` remains
 * the one declaration and projection owner.
 */
export function BrandMark({ pluginId, size, showName = false, externallyLabelled = false, testID }: BrandMarkProps): ReactElement {
  const presentationHost = useOptionalPluginUiPresentationHost();
  const displayName = usePluginBrandDisplayName(pluginId) ?? 'Plugin';
  const targetPluginId = pluginId === undefined ? undefined : pluginId.trim();
  const resource = targetPluginId ? undefined : presentationHost?.brand?.resource;
  const theme = usePluginTheme();
  const { colorScheme } = useHappierUiPlatform();
  if (targetPluginId) {
    const rendered = presentationHost?.renderBrandMark?.({
      pluginId: targetPluginId,
      ...(size === undefined ? {} : { size }),
      showName,
      externallyLabelled,
      ...(testID === undefined ? {} : { testID }),
    });
    if (rendered !== undefined) return rendered;
  }
  if (resource) {
    return <ResourceBrandMark
      displayName={displayName}
      resource={resource}
      size={size}
      showName={showName}
      externallyLabelled={externallyLabelled}
      theme={theme}
      colorScheme={colorScheme}
      testID={testID}
    />;
  }
  return (
    <HappierBrandMark
      displayName={displayName}
      size={size}
      showName={showName}
      externallyLabelled={externallyLabelled}
      theme={theme}
      colorScheme={colorScheme}
      testID={testID}
    />
  );
}

function ResourceBrandMark(props: Readonly<{
  displayName: string;
  resource: PluginUiResourceReference;
  size?: HappierImageSize;
  showName: boolean;
  externallyLabelled: boolean;
  theme: ReturnType<typeof usePluginTheme>;
  colorScheme: ReturnType<typeof useHappierUiPlatform>['colorScheme'];
  testID?: string;
}>): ReactElement {
  const { resource: snapshot } = usePluginResource(props.resource);
  const content = snapshot.value;
  return (
    <HappierBrandMark
      displayName={props.displayName}
      bytes={content?.contentType === 'image/png' ? content.bytes : undefined}
      size={props.size}
      showName={props.showName}
      externallyLabelled={props.externallyLabelled}
      theme={props.theme}
      colorScheme={props.colorScheme}
      testID={props.testID}
    />
  );
}
