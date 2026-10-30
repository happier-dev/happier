import { describe, expect, it } from 'vitest';

describe('toolViewRegistry (execute/codexbash)', () => {
    it('maps execute and CodexBash to the generic Bash renderer', async () => {
        const [{ getToolViewComponent }, { BashView }] = await Promise.all([
            import('./_registry'),
            import('../system/BashView'),
        ]);

        expect(getToolViewComponent('execute')).toBe(BashView);
        expect(getToolViewComponent('CodexBash')).toBe(BashView);
        expect(getToolViewComponent('Bash')).toBe(BashView);
    });
});
