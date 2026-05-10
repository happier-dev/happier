import { z } from 'zod';

export const CODEX_EXTERNAL_SESSIONS_PROVIDER_ID = 'codex' as const;

export const CodexExternalSessionsSourceSchema = z
  .object({
    kind: z.literal('codexHome'),
    home: z.enum(['user', 'connectedService']),
    homePath: z.string().min(1).optional(),
    connectedServiceId: z.string().min(1).optional(),
    connectedServiceProfileId: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.home === 'connectedService') {
      if (!value.connectedServiceId) {
        ctx.addIssue({ code: 'custom', message: 'connectedServiceId is required when home=connectedService', path: ['connectedServiceId'] });
      }
      return;
    }
    if (value.connectedServiceId) {
      ctx.addIssue({ code: 'custom', message: 'connectedServiceId is not allowed when home=user', path: ['connectedServiceId'] });
    }
    if (value.connectedServiceProfileId) {
      ctx.addIssue({ code: 'custom', message: 'connectedServiceProfileId is not allowed when home=user', path: ['connectedServiceProfileId'] });
    }
  });

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveCodexExternalSessionsSourceKey(source: z.infer<typeof CodexExternalSessionsSourceSchema>): string {
  const home = source.home === 'connectedService' ? 'connectedService' : 'user';
  const connectedServiceId = home === 'connectedService' ? normalizeNullableString(source.connectedServiceId) : '';
  const connectedServiceProfileId = home === 'connectedService' ? normalizeNullableString(source.connectedServiceProfileId) : '';
  const homePath = normalizeNullableString(source.homePath);
  return `codexHome:${home}:${connectedServiceId}:${connectedServiceProfileId}:${homePath}`;
}
