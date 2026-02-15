import { describe, expect, test } from 'vitest';

import { buildResumeHappySessionRpcParams } from './resumeSessionPayload';

describe('buildResumeHappySessionRpcParams', () => {
    test('builds typed params for resume-session', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            modelId: 'claude-sonnet-4-5',
            modelUpdatedAt: 123,
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            modelId: 'claude-sonnet-4-5',
            modelUpdatedAt: 123,
        });
    });

    test('omits model override when pair is incomplete', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            modelUpdatedAt: 123,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
        });

        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            modelId: 'claude-sonnet-4-5',
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
        });
    });

    test('omits sentinel default model override', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            modelId: 'default',
            modelUpdatedAt: 123,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
        });
    });
});
