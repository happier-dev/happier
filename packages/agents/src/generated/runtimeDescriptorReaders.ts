/**
 * GENERATED FILE CONTRACT (A.16y.3-provider-session-control-and-runtime-descriptor-projections)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import {
  createGeneratedRuntimeDescriptorReader,
  type GeneratedRuntimeDescriptorReaderConfig,
} from '../runtime/identity/generatedRuntimeProjection.js';
import {
  createProviderSessionIdRuntimeDescriptorReader,
} from '../runtime/identity/providerSessionIdReader.js';
import type { RuntimeDescriptorReaderMap } from '../runtime/identity/runtimeDescriptorTypes.js';

const CODEX_GENERATED_RUNTIME_DESCRIPTOR_READER = createGeneratedRuntimeDescriptorReader(
{
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
} satisfies GeneratedRuntimeDescriptorReaderConfig<'codex'>,
);

const OPENCODE_GENERATED_RUNTIME_DESCRIPTOR_READER = createGeneratedRuntimeDescriptorReader(
{
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
} satisfies GeneratedRuntimeDescriptorReaderConfig<'opencode'>,
);

export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const;

export type GeneratedRuntimeDescriptorReaderProviderId =
  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];

export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({
  codex: CODEX_GENERATED_RUNTIME_DESCRIPTOR_READER,
  opencode: OPENCODE_GENERATED_RUNTIME_DESCRIPTOR_READER,
  pi: createProviderSessionIdRuntimeDescriptorReader({
    providerId: 'pi',
    runtimeHandle: 'providerSessionId',
  }),
});
