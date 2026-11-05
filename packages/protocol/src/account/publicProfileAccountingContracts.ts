import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PublicCoverageV1Schema, PublicPeriodV1Schema, PublicUsageFactsV1Schema } from './publicProfile.js';
import { UsageAgentCalendarSchema } from '../usage/usageAgentCalendar.js';
import { UsageAccountingSessionMembershipSchema } from '../usage/usageAccountingMembership.js';

export const PublicProfilePrivateFactsSchema = lazyZodSchema(() => z.pick(PublicUsageFactsV1Schema, {
  agentTimeMs: true, peakParallel: true, weeklyPeakParallel: true, sessionDurations: true, dayNightActivity: true, mergedPrs: true,
}));
export type PublicProfilePrivateFacts = z.infer<typeof PublicProfilePrivateFactsSchema>;
export const PublicProfilePrivateAccountingFactsSchema = lazyZodSchema(() => z.pick(PublicUsageFactsV1Schema, {
  agentMix: true, agentActiveDays: true, weeklyAgentMix: true,
}));
export const PublicProfilePrivateFieldCoverageSchema = lazyZodSchema(() => z.partialRecord(
  z.enum(['agentTime', 'peakParallel', 'weeklyPeakParallel', 'sessionDurations', 'dayNightActivity', 'mergedPrs']), PublicCoverageV1Schema));

const PublicProfileAccountingPopulationSchema = lazyZodSchema(() => z.strictObject({
  contributionCount: z.number().check(z.int(), z.nonnegative()), coverage: PublicCoverageV1Schema,
  facts: z.pick(PublicUsageFactsV1Schema, { tokens: true, agentMix: true, agentActiveDays: true, weeklyAgentMix: true, footprint: true }),
  days: z.array(z.strictObject({ date: z.string(), eventCount: z.nullable(z.number().check(z.int(), z.nonnegative())) })),
  agentMethods: z.array(z.strictObject({ agentId: z.nullable(z.string()), method: PublicCoverageV1Schema.shape.method })),
  calendar: UsageAgentCalendarSchema,
}));
export type PublicProfileAccountingPopulation = z.infer<typeof PublicProfileAccountingPopulationSchema>;
export const PublicProfileAccountingProjectionSchema = lazyZodSchema(() => z.strictObject({
  period: PublicPeriodV1Schema, total: PublicProfileAccountingPopulationSchema,
  lenses: z.array(z.strictObject({ execution: z.enum(['happier', 'outside']), population: PublicProfileAccountingPopulationSchema,
    workMembershipComplete: z.boolean() })),
  membership: UsageAccountingSessionMembershipSchema,
}));
export type PublicProfileAccountingProjection = z.infer<typeof PublicProfileAccountingProjectionSchema>;
