import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { readCredentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import type { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import type { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { ForkSurfaceV1 } from '@happier-dev/agents';

import type { SessionLifecycleMachineHandlers } from '../sessionLifecycleTypes';

export type ForkLifecycleCredentials = NonNullable<Awaited<ReturnType<typeof readCredentials>>>;
export type ForkLifecycleRawSession = NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>;
export type ForkLifecycleMetadata = NonNullable<ReturnType<typeof tryDecryptSessionMetadata>>;
export type ForkBackendResolution = Extract<
    Awaited<ReturnType<ReturnType<typeof getSessionHostBridge>['resolveSessionForkBackendTarget']>>,
    { ok: true }
>;
export type ForkInheritedOverrides = ReturnType<typeof resolveForkInheritedOverridesFromMetadata>;
export type ForkBridgeSurface = ForkSurfaceV1 | null;
export type ForkPoint = Readonly<
    | { type: 'seq'; upToSeqInclusive: number }
    | { type: 'latest' }
>;

export type ForkLifecycleResult = Readonly<
    | { ok: true; childSessionId: string }
    | { ok: false; errorCode: string; errorMessage: string }
>;

export type ForkStrategyAttemptResult = ForkLifecycleResult | null;

export type ForkSpawnSession = SessionLifecycleMachineHandlers['spawnSession'];
export type ForkStopSession = SessionLifecycleMachineHandlers['stopSession'];
export type ForkSpawnOptions = SpawnSessionOptions;
