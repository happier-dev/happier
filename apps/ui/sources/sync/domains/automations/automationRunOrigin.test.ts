import { describe, expect, it } from 'vitest';

import { getAutomationDefinitionRunOriginAt } from './automationRunOrigin';

describe('getAutomationDefinitionRunOriginAt', () => {
    it('uses the origin fact for every V3 run kind rather than mutable lifecycle timestamps', () => {
        expect(getAutomationDefinitionRunOriginAt({ origin: { kind: 'scheduled', scheduledFor: 10 } } as any)).toBe(10);
        expect(getAutomationDefinitionRunOriginAt({ origin: { kind: 'manual', invokedAt: 20 } } as any)).toBe(20);
        expect(getAutomationDefinitionRunOriginAt({
            origin: { kind: 'pluginEvent', occurrenceKey: 'o1', sourceSelectorId: 's1', occurredAt: 30 },
        } as any)).toBe(30);
        expect(getAutomationDefinitionRunOriginAt({
            origin: { kind: 'conversation', occurrenceKey: 'o2', occurredAt: 40 },
        } as any)).toBe(40);
    });
});
