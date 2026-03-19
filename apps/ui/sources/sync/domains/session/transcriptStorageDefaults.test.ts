import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { readAccountTranscriptStorageDefaults, resolveNewSessionDefaultTranscriptStorage } from './transcriptStorageDefaults';

describe('resolveNewSessionDefaultTranscriptStorage', () => {
    it('prefers configured ACP backend profile defaults over account defaults', () => {
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: 'persisted',
            byTargetKey: {
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' })]: 'persisted',
            },
            enabledBackendTargets: [{ kind: 'configuredAcpBackend', backendId: 'review-bot' }],
        });

        expect(resolveNewSessionDefaultTranscriptStorage({
            agentType: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            accountDefaults,
            profileDefaultsByTargetKey: {
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' })]: 'direct',
            },
        })).toBe('direct');
    });

    it('uses target-keyed account defaults for configured ACP backends', () => {
        const target = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: 'persisted',
            byTargetKey: {
                [buildBackendTargetKey(target)]: 'direct',
            },
            enabledBackendTargets: [target],
        });

        expect(resolveNewSessionDefaultTranscriptStorage({
            agentType: 'customAcp',
            backendTarget: target,
            accountDefaults,
        })).toBe('direct');
    });
});
