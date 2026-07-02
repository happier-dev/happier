import { z } from 'zod';

export const PluginRequestInterceptorScopeV1Schema = z.enum(['plugin-fetch']);
export type PluginRequestInterceptorScopeV1 = z.infer<typeof PluginRequestInterceptorScopeV1Schema>;

function isValidRequestInterceptorUrlOrigin(value: string): boolean {
  if (value === '*') {
    return true;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin === value
      && parsed.origin !== 'null'
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

export const PluginRequestInterceptorUrlOriginV1Schema = z.string().trim().min(1).refine(
  isValidRequestInterceptorUrlOrigin,
  'urlOrigins entries must be "*" or an absolute HTTP(S) origin, for example https://api.example.com',
);
export type PluginRequestInterceptorUrlOriginV1 = z.infer<typeof PluginRequestInterceptorUrlOriginV1Schema>;

export const PluginRequestInterceptorTargetV1Schema = z.object({
  scope: PluginRequestInterceptorScopeV1Schema,
  urlOrigins: z.array(PluginRequestInterceptorUrlOriginV1Schema).optional(),
}).strict();
export type PluginRequestInterceptorTargetV1 = z.infer<typeof PluginRequestInterceptorTargetV1Schema>;

export const PluginRequestInterceptorContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  order: z.number().int().optional(),
  targets: z.array(PluginRequestInterceptorTargetV1Schema).min(1),
}).strict();
export type PluginRequestInterceptorContributionV1 = z.infer<typeof PluginRequestInterceptorContributionV1Schema>;

export type RequestInterceptorHeaderPatchV1 = Readonly<{
  remove?: readonly string[];
  set?: Readonly<Record<string, string>>;
}>;

export type RequestInterceptorRequestPatchV1 = Readonly<{
  url?: string;
  method?: string;
  headers?: RequestInterceptorHeaderPatchV1;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type RequestPolicyResultV1 =
  | Readonly<{
      kind: 'allow';
      request?: RequestInterceptorRequestPatchV1;
      auditMetadata?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'deny';
      code: string;
      reason?: string;
      auditMetadata?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'error';
      code: string;
      reason?: string;
      retryable?: boolean;
      auditMetadata?: Readonly<Record<string, unknown>>;
    }>;
