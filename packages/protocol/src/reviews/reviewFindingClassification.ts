import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ReviewFindingSeveritySchema = lazyZodSchema(() => z.enum(['blocker', 'high', 'medium', 'low', 'nit']));
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;
export const ReviewFindingCategorySchema = lazyZodSchema(() => z.enum(['correctness', 'security', 'performance', 'maintainability', 'testing', 'style', 'docs']));
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;
export const ReviewFindingScopeAttributionSchema = lazyZodSchema(() => z.enum(['pre_existing', 'in_selected_changes', 'unknown']));
export type ReviewFindingScopeAttribution = z.infer<typeof ReviewFindingScopeAttributionSchema>;
