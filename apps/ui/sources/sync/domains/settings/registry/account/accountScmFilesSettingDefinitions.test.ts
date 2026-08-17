import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';

describe('Protocol SCM Account settings', () => {
    it('keeps the released backend preference strict and stores qualified selections separately', () => {
        const legacy = ACCOUNT_SETTING_DEFINITIONS.scmGitRepoPreferredBackend;
        const qualified = Reflect.get(
            ACCOUNT_SETTING_DEFINITIONS,
            'scmGitRepoPreferredBackendQualifiedId',
        ) as Readonly<{
            default: unknown;
            schema: { safeParse(value: unknown): Readonly<{ success: boolean }> };
        }> | undefined;

        expect(legacy.schema.safeParse('git').success).toBe(true);
        expect(legacy.schema.safeParse('sapling').success).toBe(true);
        expect(legacy.schema.safeParse('acme.scm/stacked').success).toBe(false);
        expect(qualified?.default).toBeNull();
        expect(qualified?.schema.safeParse('acme.scm/stacked').success).toBe(true);
        expect(qualified?.schema.safeParse('stacked').success).toBe(false);
    });
});
