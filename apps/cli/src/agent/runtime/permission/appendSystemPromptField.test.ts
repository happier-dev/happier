import { describe, expect, it } from 'vitest';

type AppendSystemPromptFieldModule = Readonly<{
    resolveAppendSystemPromptModeOverride: (
        metadata: Record<string, unknown> | undefined,
    ) => { appendSystemPrompt?: string | null };
    resolveAppendSystemPromptBaseOverride: (
        mode: Record<string, unknown> | undefined,
    ) => string | null | undefined;
    resolveAppendSystemPromptQueueKeyValue: (
        mode: Record<string, unknown> | undefined,
    ) => string | null | '__unset__';
}>;

async function importModule(): Promise<AppendSystemPromptFieldModule | null> {
    try {
        return (await import('./appendSystemPromptField')) as AppendSystemPromptFieldModule;
    } catch {
        return null;
    }
}

describe('appendSystemPromptField', () => {
    it('preserves unset vs explicit null semantics across metadata, base overrides, and queue keys', async () => {
        const mod = await importModule();
        expect(mod).not.toBeNull();

        expect(mod!.resolveAppendSystemPromptModeOverride(undefined)).toEqual({});
        expect(mod!.resolveAppendSystemPromptBaseOverride({})).toBeUndefined();
        expect(mod!.resolveAppendSystemPromptQueueKeyValue({})).toBe('__unset__');

        expect(mod!.resolveAppendSystemPromptModeOverride({ appendSystemPrompt: null })).toEqual({
            appendSystemPrompt: null,
        });
        expect(mod!.resolveAppendSystemPromptBaseOverride({ appendSystemPrompt: null })).toBeNull();
        expect(mod!.resolveAppendSystemPromptQueueKeyValue({ appendSystemPrompt: null })).toBeNull();

        expect(mod!.resolveAppendSystemPromptModeOverride({ appendSystemPrompt: 'APPEND' })).toEqual({
            appendSystemPrompt: 'APPEND',
        });
        expect(mod!.resolveAppendSystemPromptBaseOverride({ appendSystemPrompt: 'APPEND' })).toBe('APPEND');
        expect(mod!.resolveAppendSystemPromptQueueKeyValue({ appendSystemPrompt: 'APPEND' })).toBe('APPEND');
    });

    it('reads appendSystemPrompt from prototype-less objects', async () => {
        const mod = await importModule();
        expect(mod).not.toBeNull();

        const metadata = Object.assign(Object.create(null) as Record<string, unknown>, {
            appendSystemPrompt: 'Use the latest project conventions.',
        });
        const mode = Object.assign(Object.create(null) as Record<string, unknown>, {
            appendSystemPrompt: 'Use the latest project conventions.',
        });

        expect(mod!.resolveAppendSystemPromptModeOverride(metadata)).toEqual({
            appendSystemPrompt: 'Use the latest project conventions.',
        });
        expect(mod!.resolveAppendSystemPromptBaseOverride(mode)).toBe('Use the latest project conventions.');
        expect(mod!.resolveAppendSystemPromptQueueKeyValue(mode)).toBe('Use the latest project conventions.');
    });
});
