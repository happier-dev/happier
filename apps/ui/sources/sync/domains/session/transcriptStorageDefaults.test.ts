import { describe, expect, it } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { readAccountTranscriptStorageDefaults, resolveNewSessionDefaultTranscriptStorage } from './transcriptStorageDefaults';

describe('resolveNewSessionDefaultTranscriptStorage', () => {
    it('prefers configured ACP backend profile defaults over account defaults', () => {
        const target = { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' } as const;
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: 'persisted',
            byTargetKey: {
                [resolveBackendTargetKeyV2(target)]: 'persisted',
            },
            enabledBackendTargets: [target],
        });

        expect(resolveNewSessionDefaultTranscriptStorage({
            agentType: 'codex',
            backendTarget: target,
            accountDefaults,
            profileDefaultsByTargetKey: {
                [resolveBackendTargetKeyV2(target)]: 'direct',
            },
        })).toBe('direct');
    });

    it('uses target-keyed account defaults for configured ACP backends', () => {
        const target = { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' } as const;
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: 'persisted',
            byTargetKey: {
                [resolveBackendTargetKeyV2(target)]: 'direct',
            },
            enabledBackendTargets: [target],
        });

        expect(resolveNewSessionDefaultTranscriptStorage({
            agentType: 'codex',
            backendTarget: target,
            accountDefaults,
        })).toBe('direct');
    });
});
