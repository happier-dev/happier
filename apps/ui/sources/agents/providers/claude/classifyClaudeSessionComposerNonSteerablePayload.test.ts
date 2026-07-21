import { describe, expect, it } from 'vitest';

import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import { classifyClaudeSessionComposerNonSteerablePayload } from './classifyClaudeSessionComposerNonSteerablePayload';

describe('classifyClaudeSessionComposerNonSteerablePayload', () => {
    it('compares optimistic config against the newest valid metadata alias', () => {
        const current: AcpConfigOptionOverridesV1 = {
            v: 1,
            updatedAt: 20,
            overrides: { reasoning_effort: { updatedAt: 20, value: 'high' } },
        };
        const session = {
            metadata: {
                sessionConfigOptionOverridesV1: current,
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: { reasoning_effort: { updatedAt: 10, value: 'low' } },
                },
            },
        } as unknown as Session;

        expect(classifyClaudeSessionComposerNonSteerablePayload({
            session,
            configOptionOverrides: current,
        })).toBeNull();
    });
});
