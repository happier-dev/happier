import { useCallback, type ReactElement } from 'react';

import type { PluginUiResourceReference } from '../hostApi/resourceStore.js';
import { usePluginResource } from '../hostApi/index.js';
import { HappierBrandMark, HappierImage, type HappierImageSize } from '../presentation/content/Image.js';
import { resolveHappierIconSize } from '../presentation/content/Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginHostApi, usePluginHostApiMountedPluginId } from '../hostApi/context.js';
import { usePageHeaderMarkGlyphPx } from './pageHeaderMark.js';

function useImageDecodeDiagnostic(resource: PluginUiResourceReference): () => void {
  const hostApi = usePluginHostApi();
  return useCallback(() => {
    hostApi.diagnostic({
      code: 'plugin_renderable_image_decode_failed',
      severity: 'warning',
      message: 'The platform image decoder could not render this packaged PNG.',
      details: { resource },
    });
  }, [hostApi, resource]);
}

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
  const onDecodeError = useImageDecodeDiagnostic(resource);
  return (
    <HappierImage
      bytes={content?.contentType === 'image/png' ? content.bytes : undefined}
      size={size}
      accessibilityLabel={accessibilityLabel}
      fallback={fallback}
      theme={theme}
      testID={testID}
      onDecodeError={onDecodeError}
    />
  );
}

export type BrandMarkProps = Readonly<{
  /** Exact host-known package target; omitted preserves the mounted plugin brand. */
  pluginId?: string;
  size?: ImageProps['size'];
  /** Exact mark slot supplied by the containing presentation owner. */
  pixelSize?: number;
  showName?: boolean;
  /** An adjacent host-owned label already supplies the one canonical name. */
  externallyLabelled?: boolean;
  /**
   * Happier's own mark instead of a package brand, for content Happier itself holds (a personal task). Decorative,
   * so pair it with a label; without a host renderer it falls back to the mounted plugin's brand.
   */
  host?: boolean;
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
export function BrandMark({ pluginId, size, pixelSize: requestedPixelSize, showName = false, externallyLabelled = false, host = false, testID }: BrandMarkProps): ReactElement {
  // A small mark sits beside text (a byline, a cell): at a small glyph's step, not the 32 px image step,
  // where a filled brand reads as a heavy disk. Larger marks keep their image steps.
  const pageHeaderGlyphPx = usePageHeaderMarkGlyphPx();
  const pixelSize = requestedPixelSize ?? pageHeaderGlyphPx ?? (size === 'small' ? resolveHappierIconSize('small') : undefined);
  const presentationHost = useOptionalPluginUiPresentationHost();
  const displayName = usePluginBrandDisplayName(pluginId) ?? 'Plugin';
  const mountedPluginId = usePluginHostApiMountedPluginId();
  const requestedPluginId = pluginId?.trim();
  const resource = requestedPluginId ? undefined : presentationHost?.brand?.resource;
  // The package asset owner serves mounted and explicitly targeted marks. The
  // surface entry already binds the package identity, even when the daemon has
  // no Resource generation and the app owns the bundled artwork instead.
  const targetPluginId = requestedPluginId || mountedPluginId || resource?.pluginId;
  const theme = usePluginTheme();
  const hostMark = host && pixelSize !== undefined
    ? presentationHost?.renderHostMark?.({ pixelSize, ...(testID === undefined ? {} : { testID }) })
    : undefined;
  if (hostMark !== undefined && hostMark !== null) return <>{hostMark}</>;
  if (targetPluginId) {
    const rendered = presentationHost?.renderBrandMark?.({
      pluginId: targetPluginId,
      ...(size === undefined ? {} : { size }),
      ...(pixelSize === undefined ? {} : { pixelSize }),
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
      pixelSize={pixelSize}
      showName={showName}
      externallyLabelled={externallyLabelled}
      theme={theme}
      monochrome={presentationHost?.brand?.monochrome}
      testID={testID}
    />;
  }
  return (
    <HappierBrandMark
      displayName={displayName}
      size={size}
      pixelSize={pixelSize}
      showName={showName}
      externallyLabelled={externallyLabelled}
      theme={theme}
      testID={testID}
    />
  );
}

function ResourceBrandMark(props: Readonly<{
  displayName: string;
  resource: PluginUiResourceReference;
  size?: HappierImageSize;
  pixelSize?: number;
  showName: boolean;
  externallyLabelled: boolean;
  theme: ReturnType<typeof usePluginTheme>;
  monochrome?: boolean;
  testID?: string;
}>): ReactElement {
  const { resource: snapshot } = usePluginResource(props.resource);
  const content = snapshot.value;
  const onDecodeError = useImageDecodeDiagnostic(props.resource);
  return (
    <HappierBrandMark
      displayName={props.displayName}
      bytes={content?.contentType === 'image/png' ? content.bytes : undefined}
      size={props.size}
      pixelSize={props.pixelSize}
      showName={props.showName}
      externallyLabelled={props.externallyLabelled}
      theme={props.theme}
      monochrome={props.monochrome}
      testID={props.testID}
      onDecodeError={onDecodeError}
    />
  );
}
