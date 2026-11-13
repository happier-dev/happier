import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/mini';
import { EnsureSkillSessionDirInputSchema, EnsureSkillSessionDirResultSchema, type SkillStore } from './skillStore';
import { SessionStartedSuccessReportSchema } from '@/daemon/sessions/sessionStartedReportSchema';
import { bindTrackedSessionIdentity, adoptTrackedSessionRunnerIdentity, resolveSessionReportTrackedCorrelation } from '@/daemon/sessions/sessionReportCorrelation';
import type { TrackedSession } from '@/daemon/types';
import { configuration } from '@/configuration';
import { registerExternalSessionIdentity } from '@/daemon/sessions/onHappySessionWebhook';
import type { SkillUsageRecorder } from './skillUsage';
import type { TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export const SKILL_SESSION_DIR_PATH = '/skills/session-dir';
export const SKILL_USAGE_PATH = '/skills/usage';
export const RecordSkillUseInputSchema = z.strictObject({
    skillIds: z.array(z.string().check(z.minLength(1))),
    account: z.strictObject({ accountId: z.string().check(z.minLength(1)), serverHttpBaseUrl: z.string().check(z.url()) }),
});
export const RecordSkillUseResultSchema = z.strictObject({ ok: z.literal(true) });
export const SkillSessionStartupIdentitySchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(SessionStartedSuccessReportSchema, { metadata: true }), { pid: z.number().check(z.int(), z.positive()) }));
export const SkillSessionDirControlRequestSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(EnsureSkillSessionDirInputSchema, {
    startupIdentity: z.optional(SkillSessionStartupIdentitySchema),
}));
export function registerSkillControlRoutes(app: FastifyInstance, input: Readonly<{
    skillStore?: SkillStore;
    skillUsageRecorder?: SkillUsageRecorder;
    getChildren: () => TrackedSession[];
    trackedSessionsByKey?: TrackedSessionMap;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    isShuttingDown: () => boolean;
}>): void {
    app.withTypeProvider<ZodTypeProvider>().post(SKILL_USAGE_PATH, {
        schema: { body: RecordSkillUseInputSchema, response: { 200: RecordSkillUseResultSchema,
            503: z.strictObject({ errorCode: z.literal('skills_unavailable') }) } },
        preHandler: input.requireAuth,
    }, async (request, reply) => {
        if (input.isShuttingDown() || !input.skillUsageRecorder) return reply.code(503).send({ errorCode: 'skills_unavailable' });
        await input.skillUsageRecorder.recordSkillUse(request.body);
        return { ok: true as const };
    });
    app.withTypeProvider<ZodTypeProvider>().post(SKILL_SESSION_DIR_PATH, {
        schema: { body: SkillSessionDirControlRequestSchema, response: { 200: EnsureSkillSessionDirResultSchema,
            503: z.strictObject({ errorCode: z.literal('skills_unavailable') }) } },
        preHandler: input.requireAuth,
    }, async (request, reply) => {
        if (input.isShuttingDown() || !input.skillStore) return reply.code(503).send({ errorCode: 'skills_unavailable' });
        const { startupIdentity, ...content } = request.body;
        // Run folders share their parent Session's existing process custody;
        // the context names that parent, never the Run resolver's process.
        if (content.ownerKey.includes('/') && !startupIdentity) {
            return reply.code(503).send({ errorCode: 'skills_unavailable' });
        }
        if (startupIdentity) {
            const { metadata, pid } = startupIdentity;
            if (!metadata || typeof metadata !== 'object' || metadata.hostPid !== pid || typeof metadata.path !== 'string'
                || (metadata.happyHomeDir && metadata.happyHomeDir !== configuration.happyHomeDir)) {
                return reply.code(503).send({ errorCode: 'skills_unavailable' });
            }
            const sessionId = content.ownerKey.split('/')[0]!;
            const correlated = await resolveSessionReportTrackedCorrelation({ metadata, pid,
                trackedSessionsByKey: new Map(input.getChildren().map(tracked => [tracked.trackingKey, tracked])),
                // Identity binding must not claim or settle the readiness waiter.
                spawnAwaiterByKey: new Map(),
            });
            if (correlated.kind === 'refused') {
                return reply.code(503).send({ errorCode: 'skills_unavailable' });
            }
            if (correlated.kind === 'matched') {
                if (!input.getChildren().includes(correlated.tracked)
                    || correlated.tracked.reportMarkerCustody?.retiring
                    || !bindTrackedSessionIdentity(correlated.tracked, sessionId)) {
                    return reply.code(503).send({ errorCode: 'skills_unavailable' });
                }
                if ('cancellationIdentity' in correlated) {
                    adoptTrackedSessionRunnerIdentity(correlated.tracked, correlated.cancellationIdentity);
                }
            } else {
                if (!input.trackedSessionsByKey) return reply.code(503).send({ errorCode: 'skills_unavailable' });
                const tracked = await registerExternalSessionIdentity({ trackedSessionsByKey: input.trackedSessionsByKey, pid, sessionId, metadata });
                if (!tracked) {
                    return reply.code(503).send({ errorCode: 'skills_unavailable' });
                }
            }
        }
        return input.skillStore.ensureSkillSessionDir(content);
    });
}
