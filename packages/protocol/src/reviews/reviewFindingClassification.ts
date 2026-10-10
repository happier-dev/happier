import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ReviewFindingSeveritySchema = lazyZodSchema(() => z.enum(['blocker', 'high', 'medium', 'low', 'nit']));
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;
export const ReviewFindingCategorySchema = lazyZodSchema(() => z.enum(['correctness', 'security', 'performance', 'maintainability', 'testing', 'style', 'docs']));
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;
