import { z } from 'zod/mini';
import semver from 'semver';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Canonical release SemVer shared by private releases and accepted-version projections. */
export const BotTemplateVersionV1Schema = lazyZodSchema(() => z.string().check(
  z.refine(value => semver.valid(value) === value, 'Expected a canonical full SemVer version')));
export type BotTemplateVersionV1 = z.infer<typeof BotTemplateVersionV1Schema>;
