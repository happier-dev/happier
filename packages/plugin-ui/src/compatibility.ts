import {
  PluginUiChannelV1Schema,
  PluginUiPlatformV1Schema,
  type PluginUiChannelV1,
  type PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiCompatibilityMetadata = Readonly<{
  hostUiApiVersion: string;
  reactVersion: string;
  reactNativeVersion?: string;
  expoRuntimeVersion?: string;
  hermesVersion?: string;
  platforms?: readonly PluginUiPlatformV1[];
  channels?: readonly PluginUiChannelV1[];
}>;

export type PluginUiCompatibilityInput = PluginUiCompatibilityMetadata;

function readRequiredString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }
  return trimmed;
}

export function definePluginUiCompatibility(
  input: PluginUiCompatibilityInput,
): PluginUiCompatibilityMetadata {
  return Object.freeze({
    hostUiApiVersion: readRequiredString(input.hostUiApiVersion, 'hostUiApiVersion'),
    reactVersion: readRequiredString(input.reactVersion, 'reactVersion'),
    ...(input.reactNativeVersion
      ? { reactNativeVersion: readRequiredString(input.reactNativeVersion, 'reactNativeVersion') }
      : {}),
    ...(input.expoRuntimeVersion
      ? { expoRuntimeVersion: readRequiredString(input.expoRuntimeVersion, 'expoRuntimeVersion') }
      : {}),
    ...(input.hermesVersion
      ? { hermesVersion: readRequiredString(input.hermesVersion, 'hermesVersion') }
      : {}),
    ...(input.platforms
      ? { platforms: Object.freeze(input.platforms.map((platform) => PluginUiPlatformV1Schema.parse(platform))) }
      : {}),
    ...(input.channels
      ? { channels: Object.freeze(input.channels.map((channel) => PluginUiChannelV1Schema.parse(channel))) }
      : {}),
  });
}
