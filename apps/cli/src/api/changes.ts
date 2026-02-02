import axios from 'axios';
import * as z from 'zod';
import { configuration } from '@/configuration';

export const ChangeEntrySchema = z.object({
  cursor: z.number().int().min(0),
  kind: z.string(),
  entityId: z.string(),
  changedAt: z.number().int().min(0),
  hint: z.unknown().nullable().optional(),
});

export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ChangesResponseSchema = z.object({
  changes: z.array(ChangeEntrySchema),
  nextCursor: z.number().int().min(0),
});

export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

export const CursorGoneErrorSchema = z.object({
  error: z.literal('cursor-gone'),
  currentCursor: z.number().int().min(0),
});

export type CursorGoneError = z.infer<typeof CursorGoneErrorSchema>;

export async function fetchChanges(opts: { token: string; after: number; limit?: number }): Promise<{
  status: 'ok';
  response: ChangesResponse;
} | {
  status: 'cursor-gone';
  currentCursor: number;
} | {
  status: 'error';
  error: unknown;
}> {
  const after = Number.isFinite(opts.after) && opts.after >= 0 ? Math.floor(opts.after) : 0;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 500) : 200;

  try {
    const response = await axios.get(`${configuration.serverUrl}/v2/changes`, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      params: { after, limit },
      timeout: 15_000,
      validateStatus: () => true,
    });

    if (response.status === 410) {
      const parsed = CursorGoneErrorSchema.safeParse(response.data);
      if (parsed.success) {
        return { status: 'cursor-gone', currentCursor: parsed.data.currentCursor };
      }
      return { status: 'cursor-gone', currentCursor: 0 };
    }

    if (response.status < 200 || response.status >= 300) {
      return { status: 'error', error: { status: response.status, body: response.data } };
    }

    const parsed = ChangesResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return { status: 'error', error: parsed.error };
    }

    return { status: 'ok', response: parsed.data };
  } catch (error) {
    return { status: 'error', error };
  }
}
