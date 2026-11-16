import type { ThemeProfileV1 } from '@happier-dev/protocol';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

/** A data-only source manifest, consumed by the existing manifest pack path. */
export function createThemePluginSource(params: Readonly<{
  pluginId: string; displayName: string; version: string; themes: readonly ThemeProfileV1[];
}>): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    id: params.pluginId,
    version: params.version,
    displayName: params.displayName,
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) },
    contributes: { themes: params.themes.map((theme, index) => ({ id: `theme-${index + 1}`, theme })) },
  }, null, 2)}\n`;
}
