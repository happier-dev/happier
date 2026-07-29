/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  createGeneratedRuntimeProjectionSessionControlAdapter,
  type GeneratedRuntimeProjectionSessionControlAdapterConfig,
} from '../runtime/identity/generatedRuntimeProjection.js';
import {
  createRuntimeDescriptorResumeIdSessionControlAdapter,
} from '../runtime/controlSurface/runtimeDescriptorResume.js';
import type { ProviderSessionControlAdapter } from '../runtime/controlSurface/types.js';

const CODEX_GENERATED_SESSION_CONTROL_ADAPTER = createGeneratedRuntimeProjectionSessionControlAdapter(
{
  "configuredRuntimeKind": {
    "accountSettingsField": "codexBackendMode",
    "aliases": [
      {
        "input": "acp",
        "runtimeKind": "acp"
      },
      {
        "input": "appServer",
        "runtimeKind": "appServer"
      },
      {
        "input": "mcp",
        "runtimeKind": "appServer"
      },
      {
        "input": "mcp_resume",
        "runtimeKind": "acp"
      }
    ],
    "booleanTrueField": "experimentalCodexAcp",
    "booleanTrueRuntimeKind": "acp",
    "defaultRuntimeKind": "appServer"
  },
  "controlRuntimeKind": {
    "aliases": [
      {
        "input": "acp",
        "runtimeKind": "acp"
      },
      {
        "input": "appServer",
        "runtimeKind": "appServer"
      },
      {
        "input": "mcp",
        "runtimeKind": "mcp"
      },
      {
        "input": "mcp_resume",
        "runtimeKind": "acp"
      }
    ],
    "genericState": {
      "fields": [
        "sessionModesV1",
        "sessionModelsV1",
        "sessionConfigOptionsV1",
        "acpSessionModesV1",
        "acpSessionModelsV1",
        "acpConfigOptionsV1"
      ],
      "providerId": "codex",
      "runtimeKind": "appServer"
    },
    "metadataPaths": [
      {
        "path": [
          "codexRuntimeDescriptorV1",
          "backendMode"
        ]
      },
      {
        "path": [
          "affinity",
          "backendMode"
        ]
      },
      {
        "path": [
          "codexBackendMode"
        ]
      },
      {
        "path": [
          "directSessionV1",
          "codexBackendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "externalSessionV1",
          "codexBackendMode"
        ]
      }
    ],
    "rawDescriptorPaths": [
      {
        "path": [
          "agent",
          "agentExtra",
          "runtimeHandle",
          "backendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "agent",
          "agentExtra",
          "runtimeAffinity",
          "backendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "agent",
          "backendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "provider",
          "providerExtra",
          "runtimeHandle",
          "backendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "provider",
          "providerExtra",
          "runtimeAffinity",
          "backendMode"
        ],
        "providerId": "codex"
      },
      {
        "path": [
          "provider",
          "backendMode"
        ],
        "providerId": "codex"
      }
    ]
  },
  "experimentalVendorHandoff": {
    "accountSettingsField": "codexBackendMode",
    "accountSettingsValues": [
      "acp",
      "appServer",
      "mcp_resume"
    ],
    "booleanTrueField": "experimentalCodexAcp",
    "runtimeKinds": [
      "acp",
      "appServer"
    ]
  },
  "experimentalVendorResume": {
    "accountSettingsField": "codexBackendMode",
    "accountSettingsValues": [
      "acp",
      "appServer",
      "mcp_resume"
    ],
    "booleanTrueField": "experimentalCodexAcp",
    "requireConfiguredRuntimeKind": true,
    "runtimeKinds": [
      "acp",
      "appServer"
    ]
  },
  "providerId": "codex",
  "runtimeDescriptor": {
    "backendModeKey": "backendMode",
    "fields": [
      {
        "key": "backendMode",
        "kind": "runtimeKind",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "providerSessionId",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "home",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "connectedServiceId",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "connectedServiceProfileId",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "connectedServiceGroupId",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "homePath",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      }
    ],
    "legacy": {
      "fields": [
        {
          "key": "backendMode",
          "kind": "runtimeKind",
          "runtimeHandle": "whenPresent",
          "sourceKey": "codexBackendMode"
        },
        {
          "key": "providerSessionId",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent",
          "sourceKey": "codexSessionId"
        },
        {
          "key": "home",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent"
        },
        {
          "key": "connectedServiceId",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent"
        },
        {
          "key": "connectedServiceProfileId",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent"
        },
        {
          "key": "connectedServiceGroupId",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent"
        },
        {
          "key": "homePath",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent"
        }
      ],
      "requireRuntimeKind": true
    },
    "providerId": "codex",
    "runtimeKind": {
      "aliases": [
        {
          "input": "acp",
          "runtimeKind": "acp"
        },
        {
          "input": "appServer",
          "runtimeKind": "appServer"
        },
        {
          "input": "mcp",
          "runtimeKind": "appServer"
        },
        {
          "input": "mcp_resume",
          "runtimeKind": "acp"
        }
      ]
    }
  },
  "runtimeKindOverride": {
    "accountSettingsField": "codexBackendMode",
    "aliases": [
      {
        "input": "acp",
        "runtimeKind": "acp"
      },
      {
        "input": "appServer",
        "runtimeKind": "appServer"
      },
      {
        "input": "mcp",
        "runtimeKind": "appServer"
      },
      {
        "input": "mcp_resume",
        "runtimeKind": "acp"
      }
    ]
  },
  "vendorResumeId": {
    "descriptorField": "providerSessionId",
    "legacyField": "codexSessionId"
  }
} satisfies GeneratedRuntimeProjectionSessionControlAdapterConfig<'codex'>,
);

const OPENCODE_GENERATED_SESSION_CONTROL_ADAPTER = createGeneratedRuntimeProjectionSessionControlAdapter(
{
  "configuredRuntimeKind": {
    "accountSettingsField": "opencodeBackendMode",
    "aliases": [
      {
        "input": "server",
        "runtimeKind": "server"
      },
      {
        "input": "acp",
        "runtimeKind": "acp"
      }
    ],
    "caseInsensitive": true
  },
  "providerId": "opencode",
  "runtimeDescriptor": {
    "backendModeKey": "backendMode",
    "fields": [
      {
        "key": "backendMode",
        "kind": "runtimeKind",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "providerSessionId",
        "kind": "trimmedString",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "serverBaseUrl",
        "kind": "loopbackHttpOrigin",
        "runtimeHandle": "whenPresent"
      },
      {
        "key": "serverBaseUrlExplicit",
        "kind": "booleanTrue",
        "requiresField": "serverBaseUrl",
        "runtimeHandle": "booleanTrue"
      }
    ],
    "legacy": {
      "defaultRuntimeKindWhenAnyFieldPresent": "server",
      "fields": [
        {
          "key": "backendMode",
          "kind": "runtimeKind",
          "runtimeHandle": "whenPresent",
          "sourceKey": "opencodeBackendMode"
        },
        {
          "key": "providerSessionId",
          "kind": "trimmedString",
          "runtimeHandle": "whenPresent",
          "sourceKey": "opencodeSessionId"
        },
        {
          "key": "serverBaseUrl",
          "kind": "loopbackHttpOrigin",
          "runtimeHandle": "whenPresent",
          "sourceKey": "opencodeServerBaseUrl"
        },
        {
          "key": "serverBaseUrlExplicit",
          "kind": "booleanTrue",
          "requiresField": "serverBaseUrl",
          "runtimeHandle": "booleanTrue",
          "sourceKey": "opencodeServerBaseUrlExplicit"
        }
      ]
    },
    "providerId": "opencode",
    "runtimeKind": {
      "aliases": [
        {
          "input": "server",
          "runtimeKind": "server"
        },
        {
          "input": "acp",
          "runtimeKind": "acp"
        }
      ],
      "caseInsensitive": true
    }
  },
  "runtimeKindOverride": {
    "accountSettingsField": "opencodeBackendMode",
    "aliases": [
      {
        "input": "server",
        "runtimeKind": "server"
      },
      {
        "input": "acp",
        "runtimeKind": "acp"
      }
    ],
    "caseInsensitive": true,
    "fallbackRuntimeKind": "server"
  },
  "vendorResumeId": {
    "descriptorField": "providerSessionId",
    "legacyField": "opencodeSessionId"
  }
} satisfies GeneratedRuntimeProjectionSessionControlAdapterConfig<'opencode'>,
);

export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedProviderSessionControlAdapterProviderId =
  (typeof GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];

export const GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS: Readonly<Record<GeneratedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>> = Object.freeze({
  codex: CODEX_GENERATED_SESSION_CONTROL_ADAPTER,
  opencode: OPENCODE_GENERATED_SESSION_CONTROL_ADAPTER,
  pi: createRuntimeDescriptorResumeIdSessionControlAdapter({
    providerId: 'pi',
    absolutePathField: 'sessionFile',
    fallbackField: 'providerSessionId',
  }),
});
