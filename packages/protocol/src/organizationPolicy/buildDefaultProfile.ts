import { z } from 'zod';

const profileUrl = z.string().trim().url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}).transform((value) => value.replace(/\/+$/u, ''));

/** Shared field definitions for baked topology defaults and organization policy. */
export const BuildDefaultProfileFields = {
  accountService: z.object({ url: profileUrl, locked: z.boolean().optional() }).strict().optional(),
  home: z.object({ url: profileUrl, webappUrl: profileUrl.optional(), locked: z.boolean().optional() }).strict().optional(),
  personalHome: z.object({ value: z.enum(['auto', 'offer', 'off']), locked: z.boolean().optional() }).strict().optional(),
};
export const BuildDefaultProfileSchema = z.object(BuildDefaultProfileFields).strict();
export type BuildDefaultProfile = Readonly<z.infer<typeof BuildDefaultProfileSchema>>;
