import { z } from 'zod';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export const PI_PROVIDER_FIELDS = {
  piNativeTerminalEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Open the native Pi interface from an interactive terminal launch',
    storageScope: 'account',
  },
} as const satisfies SettingDefinitionMap;

export const PI_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'pi',
  fields: PI_PROVIDER_FIELDS,
});
