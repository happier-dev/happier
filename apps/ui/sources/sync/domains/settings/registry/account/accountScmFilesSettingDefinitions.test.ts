import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';

describe('Protocol SCM Account settings', () => {
    it('keeps the released backend preference strict and stores qualified selections separately', () => {
        const legacy = ACCOUNT_SETTING_DEFINITIONS.scmGitRepoPreferredBackend;
        const qualified = ACCOUNT_SETTING_DEFINITIONS.scmGitRepoPreferredBackendQualifiedId;

        expect(legacy.parseMutationValue('git').success).toBe(true);
        expect(legacy.parseMutationValue('sapling').success).toBe(true);
        expect(legacy.parseMutationValue('acme.scm/stacked').success).toBe(false);
        expect(legacy.schema.parse('acme.scm/stacked')).toBe('git');
        expect(qualified.default).toBeNull();
        expect(qualified.parseMutationValue('acme.scm/stacked').success).toBe(true);
        expect(qualified.parseMutationValue('stacked').success).toBe(false);
        expect(qualified.schema.parse('stacked')).toBeNull();
    });
});
