import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import {
    createPersonalHomeRuntimeSpec,
    renderPersonalHomeRuntimeEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

type LocalRelayRuntimeTaskKind =
    | 'relay.runtime.status.v1'
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'relay.runtime.stop.v1';

export type LocalRelayRuntimePurpose = Readonly<{
    kind: 'personal-home';
    canonicalServerUrl: string;
}>;

export type LocalRelayRuntimeTaskOptions = Readonly<{
    purpose?: LocalRelayRuntimePurpose;
    anonymousSignupEnabled?: boolean;
}>;

const LOCAL_RELAY_RUNTIME_PARAMS = {
    target: { kind: 'local' as const },
    channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
    mode: 'user' as const,
};

export function buildLocalRelayRuntimeSystemTaskSpec(
    kind: LocalRelayRuntimeTaskKind,
    options: LocalRelayRuntimeTaskOptions = {},
): SystemTaskSpec {
    const canonicalServerUrl = options.purpose?.canonicalServerUrl?.trim() ?? '';
    const purpose = canonicalServerUrl
        ? { kind: 'personal-home' as const, canonicalServerUrl }
        : undefined;
    const port = purpose ? Number(new URL(purpose.canonicalServerUrl).port) : Number.NaN;
    const env = purpose && Number.isInteger(port) && port > 0
        ? renderPersonalHomeRuntimeEnv({
            spec: createPersonalHomeRuntimeSpec({ canonicalServerUrl }),
            port,
            anonymousSignupEnabled: options.anonymousSignupEnabled,
        })
        : undefined;
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind,
        params: {
            ...LOCAL_RELAY_RUNTIME_PARAMS,
            ...(purpose ? { purpose } : {}),
            ...(env ? { env } : {}),
        },
    };
}
