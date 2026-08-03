import { z } from "zod";
import { type Fastify } from "../../types";
import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';
import { resolveClientAppVersionDecision } from '@/app/clientCompatibility/versionDecision';

const IOS_UPDATE_URL = 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388';
const POLICY_INVALID_ERROR = 'compatibility_policy_invalid' as const;

const LegacyClientVersionCheckRequestSchema = z.object({
    platform: z.string(),
    version: z.string(),
    app_id: z.string(),
});

const LegacyClientVersionCheckResponseSchema = z.object({
    update_required: z.boolean(),
    update_url: z.string().nullable(),
});

/**
 * Registers the client version endpoints. The deployed native request and
 * response remain legacy-shaped, while upgrade decisions come exclusively
 * from the session-sync compatibility policy.
 */
export function versionRoutes(app: Fastify) {
    app.get('/v1/version', {
        schema: {
            response: {
                200: z.object({
                    ok: z.literal(true),
                }),
            },
        },
    }, async () => {
        return { ok: true as const };
    });

    app.post('/v1/version', {
        schema: {
            body: LegacyClientVersionCheckRequestSchema,
            response: {
                200: LegacyClientVersionCheckResponseSchema,
                500: z.object({ error: z.literal(POLICY_INVALID_ERROR) }),
            }
        }
    }, async (request, reply) => {
        const policy = resolveSessionSyncCompatibilityPolicy(process.env);
        if (!policy.valid && policy.requestedEnforcement === 'required') {
            return reply.code(500).send({ error: POLICY_INVALID_ERROR });
        }

        const platform = request.body.platform.toLowerCase();
        if (platform !== 'ios' && platform !== 'android') {
            return { update_required: false, update_url: null };
        }

        const decision = resolveClientAppVersionDecision({
            clientKind: platform === 'ios' ? 'ui-ios' : 'ui-android',
            appVersion: request.body.version,
            policy,
            fallbackUpdateUrl: platform === 'ios' ? IOS_UPDATE_URL : null,
        });
        return {
            update_required: decision.status === 'upgrade-required',
            update_url: decision.status === 'upgrade-required' ? decision.updateUrl : null,
        };
    });
}
