import { z } from "zod";
import { type Fastify } from "../../types";
import {
    ClientVersionCheckRequestV1Schema,
    ClientVersionCheckResponseV1Schema,
} from '@happier-dev/protocol';
import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';
import { resolveClientVersionDecision } from '@/app/clientCompatibility/versionDecision';

// Upgrade destination, not an upgrade floor: the minimum version comes solely
// from the session-sync compatibility policy.
const IOS_UPDATE_URL = 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388';

const LegacyClientVersionCheckRequestSchema = z.object({
    platform: z.string(),
    version: z.string(),
    app_id: z.string(),
}).strict();

const LegacyClientVersionCheckResponseSchema = z.object({
    update_required: z.boolean(),
    update_url: z.string().nullable(),
}).strict();

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
            body: z.union([ClientVersionCheckRequestV1Schema, LegacyClientVersionCheckRequestSchema]),
            response: {
                200: z.union([ClientVersionCheckResponseV1Schema, LegacyClientVersionCheckResponseSchema]),
            }
        }
    }, async (request) => {
        const policy = resolveSessionSyncCompatibilityPolicy(process.env);
        if (!('v' in request.body)) {
            const platform = request.body.platform.toLowerCase();
            if (platform !== 'ios' && platform !== 'android') {
                return { update_required: false, update_url: null };
            }
            const decision = resolveClientVersionDecision({
                clientKind: platform === 'ios' ? 'ui-ios' : 'ui-android',
                appVersion: request.body.version,
                policy,
                distributionUpdateUrl: platform === 'ios' ? IOS_UPDATE_URL : null,
            });
            return {
                update_required: decision.status !== 'current',
                update_url: decision.status === 'current' ? null : decision.updateUrl,
            };
        }
        const { clientKind, appVersion } = request.body;
        return resolveClientVersionDecision({
            clientKind,
            appVersion,
            policy,
            ...(clientKind === 'ui-ios' ? { distributionUpdateUrl: IOS_UPDATE_URL } : null),
        });
    });
}
