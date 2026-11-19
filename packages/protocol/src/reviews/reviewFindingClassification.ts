import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const severities = ['blocker', 'high', 'medium', 'low', 'nit'] as const;
export const ReviewFindingSeveritySchema = lazyZodSchema(() => z.enum(severities));
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;
export function reviewFindingFallsBelowThreshold(severity: ReviewFindingSeverity, threshold: ReviewFindingSeverity): boolean {
  return severities.indexOf(severity) > severities.indexOf(threshold);
}
export const ReviewFindingCategorySchema = lazyZodSchema(() => z.enum(['correctness', 'security', 'performance', 'maintainability', 'testing', 'style', 'docs']));
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;
export const ReviewFindingScopeAttributionSchema = lazyZodSchema(() => z.enum(['pre_existing', 'in_selected_changes', 'unknown']));
export type ReviewFindingScopeAttribution = z.infer<typeof ReviewFindingScopeAttributionSchema>;
export const REVIEW_FINDING_SUMMARY_PLACEMENT_V1 = 'summary';
