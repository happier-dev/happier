import { FollowPolicyV1Schema, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

export function readStoredPolicy(raw: string): FollowPolicyV1 | null {
    try {
        const parsed = FollowPolicyV1Schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
