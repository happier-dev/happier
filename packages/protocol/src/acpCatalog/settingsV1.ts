import { z } from 'zod';

import { McpValueRefV1Schema, type McpValueRefV1 } from '../mcpServers/settingsV1.js';
import { KIRO_ACP_CATALOG_AUTH_PARSER_ID, KIRO_ACP_CATALOG_TRANSPORT_PROFILE_ID } from '../providers/kiro/acpCatalog.js';

const ACP_CATALOG_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
const ACP_ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const AcpCatalogIdV1Schema = z.string().min(1).regex(ACP_CATALOG_ID_REGEX, 'Invalid ACP catalog id');
const AcpEnvKeyV1Schema = z.string().regex(ACP_ENV_KEY_REGEX, 'Invalid environment variable name');

export const AcpCatalogAuthSupportV1Schema = z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']);
export type AcpCatalogAuthSupportV1 = z.infer<typeof AcpCatalogAuthSupportV1Schema>;

export const AcpCatalogAuthParserV1Schema = z.enum([
  'unknown',
  'exitCodeOnly',
  'stdoutNonEmpty',
  KIRO_ACP_CATALOG_AUTH_PARSER_ID,
]);
export type AcpCatalogAuthParserV1 = z.infer<typeof AcpCatalogAuthParserV1Schema>;

export const AcpCatalogTransportProfileV1Schema = z.enum(['generic', KIRO_ACP_CATALOG_TRANSPORT_PROFILE_ID]);
export type AcpCatalogTransportProfileV1 = z.infer<typeof AcpCatalogTransportProfileV1Schema>;

export const AcpCatalogSupportHintV1Schema = z.enum(['unknown', 'yes', 'no']);
export type AcpCatalogSupportHintV1 = z.infer<typeof AcpCatalogSupportHintV1Schema>;


export const AcpCatalogCommandV1Schema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export type AcpCatalogCommandV1 = z.infer<typeof AcpCatalogCommandV1Schema>;

export const AcpBackendAuthConfigV1Schema = z.object({
  support: AcpCatalogAuthSupportV1Schema,
  machineLoginKey: z.string().min(1).optional(),
  docsUrl: z.string().url().optional(),
  loginCommand: AcpCatalogCommandV1Schema.optional(),
  statusCommand: z.array(z.string()).optional(),
  parser: AcpCatalogAuthParserV1Schema.optional(),
  envVars: z.array(AcpEnvKeyV1Schema).optional(),
});

export type AcpBackendAuthConfigV1 = z.infer<typeof AcpBackendAuthConfigV1Schema>;

export const AcpBackendCapabilitiesV1Schema = z.object({
  supportsLoadSession: z.boolean().default(false),
  supportsModes: AcpCatalogSupportHintV1Schema.default('unknown'),
  supportsModels: AcpCatalogSupportHintV1Schema.default('unknown'),
  supportsConfigOptions: AcpCatalogSupportHintV1Schema.default('unknown'),
  promptImageSupport: AcpCatalogSupportHintV1Schema.default('unknown'),
});

export type AcpBackendCapabilitiesV1 = z.infer<typeof AcpBackendCapabilitiesV1Schema>;

export const AcpBackendDefinitionV1Schema = z.object({
  id: AcpCatalogIdV1Schema,
  name: AcpCatalogIdV1Schema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(AcpEnvKeyV1Schema, McpValueRefV1Schema).default({}),
  auth: AcpBackendAuthConfigV1Schema.optional(),
  transportProfile: AcpCatalogTransportProfileV1Schema.default('generic'),
  defaultMode: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  capabilities: AcpBackendCapabilitiesV1Schema.default({
    supportsLoadSession: false,
    supportsModes: 'unknown',
    supportsModels: 'unknown',
    supportsConfigOptions: 'unknown',
    promptImageSupport: 'unknown',
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type AcpBackendDefinitionV1 = z.infer<typeof AcpBackendDefinitionV1Schema>;

export const AcpCatalogSettingsV1Schema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  },
  z
    .object({
      v: z.literal(2).default(2),
      backends: z.array(AcpBackendDefinitionV1Schema).default([]),
    })
    .superRefine((value, ctx) => {
      const backendIds = new Set<string>();
      const backendNames = new Set<string>();
      for (let i = 0; i < value.backends.length; i++) {
        const backend = value.backends[i];
        if (backendIds.has(backend.id)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate ACP backend id: ${backend.id}`, path: ['backends', i, 'id'] });
        } else {
          backendIds.add(backend.id);
        }
        if (backendNames.has(backend.name)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate ACP backend name: ${backend.name}`, path: ['backends', i, 'name'] });
        } else {
          backendNames.add(backend.name);
        }
      }
    }),
);

export type AcpCatalogSettingsV1 = z.infer<typeof AcpCatalogSettingsV1Schema>;

export type AcpCatalogEnvValueRefV1 = McpValueRefV1;
