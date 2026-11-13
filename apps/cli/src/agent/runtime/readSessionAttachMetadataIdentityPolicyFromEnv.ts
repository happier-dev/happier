import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SessionAttachMetadataIdentityPolicySchema } from '@happier-dev/protocol/sessions/attach/metadataIdentityPolicy';
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol';

export function readSessionAttachMetadataIdentityPolicyFromEnv(): SessionAttachMetadataIdentityPolicy | null {
    const env = sessionProcessEnvironment();
    const raw = typeof env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY === 'string'
        ? env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY.trim()
        : '';
    delete env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY;
    if (!raw) {
        return null;
    }
    const parsed = SessionAttachMetadataIdentityPolicySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
