import { describe, expect, it } from 'vitest';

describe('rewriteFlushHookEffects script', () => {
    it('rewrites trailing microtask and animation-frame flush tails onto flushHookEffects', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            "        capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });",
            '        capturedFlashListProps.onContentSizeChange?.(0, 1200);',
            '        await Promise.resolve();',
            '        await Promise.resolve();',
            '        await flushAnimationFrame();',
            '        await flushAnimationFrame();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'ChatList.flashListV2.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.flushHookEffectsTail).toBe(1);
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).toContain([
            '    await act(async () => {',
            "        capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });",
            '        capturedFlashListProps.onContentSizeChange?.(0, 1200);',
            '        await flushHookEffects({ cycles: 1, turns: 2, frames: 2 });',
            '    });',
        ].join('\n'));
    });

    it('rewrites fake-timer advancement plus trailing microtask tails onto flushHookEffects', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        vi.advanceTimersByTime(1500);',
            '        await Promise.resolve();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'ChatList.flashListV2.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.flushHookEffectsTail).toBe(1);
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).toContain([
            '    await act(async () => {',
            '        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 1500 });',
            '    });',
        ].join('\n'));
    });

    it('rewrites pure fake-timer advancement blocks onto flushHookEffects with turns disabled', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        vi.advanceTimersByTime(249);',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'SessionView.directSessions.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.flushHookEffectsTail).toBe(1);
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).toContain([
            '    await act(async () => {',
            '        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 249 });',
            '    });',
        ].join('\n'));
    });

    it('rewrites pure runOnlyPendingTimers blocks onto flushHookEffects with turns disabled', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        vi.runOnlyPendingTimers();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'SessionView.directSessions.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.flushHookEffectsTail).toBe(1);
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).toContain([
            '    await act(async () => {',
            '        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });',
            '    });',
        ].join('\n'));
    });

    it('moves an existing barrel flushHookEffects import onto the leaf helper module', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { flushHookEffects, standardCleanup } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        await Promise.resolve();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'ChatList.flashListV2.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { standardCleanup } from '@/dev/testkit';");
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).not.toContain("import { flushHookEffects, standardCleanup } from '@/dev/testkit';");
    });

    it('repairs an already-rewritten file that still imports flushHookEffects from the barrel', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { flushHookEffects } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        await flushHookEffects({ cycles: 1, turns: 2 });',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'ChatList.flashListV2.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';");
        expect(result.text).not.toContain("import { flushHookEffects } from '@/dev/testkit';");
    });

    it('does not rewrite non-trailing microtask waits that are mixed into the main act body', async () => {
        const migrationModule = await import('./rewrite-flush-hook-effects');

        const input = [
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    await act(async () => {',
            '        await Promise.resolve();',
            '        doSomething();',
            '        await Promise.resolve();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteFlushHookEffects(input, 'mixed-flush.test.tsx');

        expect(result.changed).toBe(false);
        expect(result.counts.flushHookEffectsTail).toBe(0);
    });
});
