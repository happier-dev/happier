import { z } from 'zod';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

import type { KimiAcpPythonSelector } from '../agent/preferences/session.js';

export type { KimiAcpPythonSelector } from '../agent/preferences/session.js';
export {
  normalizeKimiAcpPythonSelector,
  resolveKimiSpawnExtrasFromSettings,
} from '../agent/preferences/session.js';

export const KIMI_PROVIDER_FIELDS = {
  kimiAcpPythonSelector: {
    schema: z.enum(['auto', 'poll']),
    default: 'auto' satisfies KimiAcpPythonSelector,
    description: 'Kimi ACP Python stdio selector compatibility mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
} as const satisfies SettingDefinitionMap;

export const KIMI_PROVIDER_SETTINGS_PLUGIN = {
  providerId: 'kimi',
  title: { key: 'settingsProviders.plugins.kimi.title' },
  icon: { ionName: 'leaf-outline', color: { kind: 'theme', token: 'green' } },
  settings: KIMI_PROVIDER_FIELDS,
  uiSections: [
    {
      id: 'kimiCompatibility',
      title: { key: 'settingsProviders.plugins.kimi.sections.compatibility.title' },
      footer: { key: 'settingsProviders.plugins.kimi.sections.compatibility.footer' },
      fields: [
        {
          key: 'kimiAcpPythonSelector',
          kind: 'enum',
          title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.title' },
          subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.subtitle' },
          enumOptions: [
            {
              id: 'auto',
              title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.title' },
              subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.auto.subtitle' },
            },
            {
              id: 'poll',
              title: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.title' },
              subtitle: { key: 'settingsProviders.plugins.kimi.fields.kimiAcpPythonSelector.options.poll.subtitle' },
            },
          ],
        },
      ],
    },
  ],
} as const;
