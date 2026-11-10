import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
    RepositoryCheckpointCapturePhase,
    RepositoryCheckpointRef,
    RepositoryCheckpointRefs,
} from './types';

const CHECKPOINT_REF_ROOT = 'refs/happier/checkpoints';
const INVALID_GIT_REF_SUFFIX_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;
const SUPPORTED_CHECKPOINT_CAPTURE_PHASES = new Set<RepositoryCheckpointCapturePhase>([
    'message-start',
    'turn-start',
    'turn-final',
]);

function assertNonEmpty(value: string, label: string): void {
    if (value.trim().length === 0) {
        throw new Error(`${label} must not be empty`);
    }
}

function assertSafeCheckpointId(value: string, label: string): void {
    assertNonEmpty(value, label);
    const segments = value.split('/');
    if (
        value.startsWith('/')
        || value.endsWith('/')
        || value.includes('//')
        || value === '@'
        || value.includes('..')
        || value.includes('@{')
        || INVALID_GIT_REF_SUFFIX_CHARS.test(value)
        || segments.some((segment) => (
            segment === '.'
            || segment === '..'
            || segment.startsWith('.')
            || segment.endsWith('.')
            || segment.endsWith('.lock')
        ))
    ) {
        throw new Error(`${label} is not a safe checkpoint ref id`);
    }
}

function assertSupportedCheckpointPhase(value: string): asserts value is RepositoryCheckpointCapturePhase {
    if (!SUPPORTED_CHECKPOINT_CAPTURE_PHASES.has(value as RepositoryCheckpointCapturePhase)) {
        throw new Error('checkpoint phase is not supported');
    }
}

function buildCheckpointRefSuffix(phase: RepositoryCheckpointCapturePhase, checkpointId: string): string {
    assertNonEmpty(checkpointId, 'checkpointId');
    try {
        assertSafeCheckpointId(checkpointId, 'checkpointId');
        return `${phase}/${checkpointId}`;
    } catch {
        // A separate root cannot collide with any supported phase/id ref.
        // UTF-16 preserves the opaque JavaScript identity without replacement.
        return `encoded/${phase}/${Buffer.from(checkpointId, 'utf16le').toString('base64url')}`;
    }
}

export function encodeRepositoryCheckpointScope(scopeId: string): string {
    assertNonEmpty(scopeId, 'scopeId');
    const encoded = Buffer.from(scopeId, 'utf8').toString('base64url');
    // Loose Git refs and retained evidence use this ASCII name as a filesystem
    // component (255 bytes). Preserve existing valid names; a dot keeps the
    // bounded namespace disjoint from legacy base64url scope names.
    return encoded.length <= 255 ? encoded : `sha256.${createHash('sha256').update(scopeId, 'utf8').digest('hex')}`;
}

export function buildRepositoryCheckpointScopePrefix(scopeId: string): string {
    return `${CHECKPOINT_REF_ROOT}/${encodeRepositoryCheckpointScope(scopeId)}/`;
}

export function buildRepositoryCheckpointRef(input: {
    scopeId: string;
    phase: RepositoryCheckpointCapturePhase;
    checkpointId: string;
}): RepositoryCheckpointRef {
    const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
    assertSupportedCheckpointPhase(input.phase);
    const suffix = buildCheckpointRefSuffix(input.phase, input.checkpointId);
    return {
        scopeId: input.scopeId,
        encodedScope,
        phase: input.phase,
        checkpointId: input.checkpointId,
        ref: `${CHECKPOINT_REF_ROOT}/${encodedScope}/${suffix}`,
    };
}

export function buildRepositoryCheckpointRefs(input: {
    scopeId: string;
    messageId?: string;
    turnId?: string;
}): RepositoryCheckpointRefs {
    const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
    return {
        scopeId: input.scopeId,
        encodedScope,
        messageStart: input.messageId
            ? buildRepositoryCheckpointRef({
                scopeId: input.scopeId,
                phase: 'message-start',
                checkpointId: input.messageId,
            })
            : undefined,
        turnStart: input.turnId
            ? buildRepositoryCheckpointRef({
                scopeId: input.scopeId,
                phase: 'turn-start',
                checkpointId: input.turnId,
            })
            : undefined,
        turnFinal: input.turnId
            ? buildRepositoryCheckpointRef({
                scopeId: input.scopeId,
                phase: 'turn-final',
                checkpointId: input.turnId,
            })
            : undefined,
    };
}

export function parseRepositoryCheckpointRef(input: {
    scopeId: string;
    ref: string;
}): Pick<RepositoryCheckpointRef, 'encodedScope' | 'phase' | 'checkpointId' | 'ref' | 'scopeId'> | null {
    const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
    const prefix = `${CHECKPOINT_REF_ROOT}/${encodedScope}/`;
    if (!input.ref.startsWith(prefix)) return null;

    const suffix = input.ref.slice(prefix.length);
    const encoded = suffix.startsWith('encoded/');
    const rest = encoded ? suffix.slice('encoded/'.length) : suffix;
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0) return null;

    const phase = rest.slice(0, slashIndex);
    try {
        assertSupportedCheckpointPhase(phase);
    } catch {
        return null;
    }

    const idSuffix = rest.slice(slashIndex + 1);
    let checkpointId = idSuffix;
    try {
        if (encoded) {
            if (!/^[A-Za-z0-9_-]+$/.test(idSuffix)) return null;
            const bytes = Buffer.from(idSuffix, 'base64url');
            if (bytes.length % 2 !== 0 || bytes.toString('base64url') !== idSuffix) return null;
            checkpointId = bytes.toString('utf16le');
            if (buildRepositoryCheckpointRef({ scopeId: input.scopeId, phase, checkpointId }).ref !== input.ref) return null;
        } else {
            assertSafeCheckpointId(checkpointId, 'checkpointId');
        }
    } catch {
        return null;
    }

    return {
        scopeId: input.scopeId,
        encodedScope,
        phase,
        checkpointId,
        ref: input.ref,
    };
}

/**
 * Tests whether a ref is a CHKPT-4 rollback-backup ref under the requested scope.
 * Rollback-backup refs intentionally use a separate phase outside the
 * capture-phase whitelist (`message-start`/`turn-start`/`turn-final`), so they
 * must be recognised separately for namespace-contained cleanup.
 */
export function isRepositoryCheckpointRollbackBackupRef(input: {
    scopeId: string;
    ref: string;
}): boolean {
    const encodedScope = encodeRepositoryCheckpointScope(input.scopeId);
    const prefix = `${CHECKPOINT_REF_ROOT}/${encodedScope}/rollback-backup/`;
    if (!input.ref.startsWith(prefix)) return false;
    const rollbackId = input.ref.slice(prefix.length);
    try {
        assertSafeCheckpointId(rollbackId, 'rollbackId');
        return true;
    } catch {
        return false;
    }
}
