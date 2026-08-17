import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
    SessionCreationKeyV1Schema,
    type SessionCreationKeyV1,
} from '@happier-dev/protocol';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

const VOICE_SPAWN_USER_ATTEMPT_DIGEST_DOMAIN = 'happier.voice.spawn-user-attempt.v1';

export function buildVoiceSpawnUserAttemptId(value: unknown): SessionCreationKeyV1 {
    const canonicalValue = stableJsonStringify(value);
    const digest = sha256(utf8ToBytes(
        `${VOICE_SPAWN_USER_ATTEMPT_DIGEST_DOMAIN}\u0000${canonicalValue}`,
    ));
    return SessionCreationKeyV1Schema.parse(`voice-session-attempt:${bytesToHex(digest)}`);
}
