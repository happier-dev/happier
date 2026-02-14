import { z } from 'zod';

export const ReviewFindingSeveritySchema = z.enum([
  'blocker',
  'high',
  'medium',
  'low',
  'nit',
]);
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;

export const ReviewFindingCategorySchema = z.enum([
  'correctness',
  'security',
  'performance',
  'maintainability',
  'testing',
  'style',
  'docs',
]);
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: ReviewFindingSeveritySchema,
  category: ReviewFindingCategorySchema,
  filePath: z.string().min(1).optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  summary: z.string().min(1),
  suggestion: z.string().min(1).optional(),
  patch: z.string().min(1).optional(),
}).passthrough();

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewFindingId = string;

