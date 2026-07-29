import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agents/registry/registryCore', () => ({
    DEFAULT_AGENT_ID: 'codex',
}));

import { ACCOUNT_SCM_FILES_SETTING_DEFINITIONS } from './accountScmFilesSettingDefinitions';

describe('ACCOUNT_SCM_FILES_SETTING_DEFINITIONS', () => {
    it('keeps the released backend preference strict and stores qualified selections separately', () => {
        const legacy = ACCOUNT_SCM_FILES_SETTING_DEFINITIONS.scmGitRepoPreferredBackend;
        const qualified = Reflect.get(
            ACCOUNT_SCM_FILES_SETTING_DEFINITIONS,
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
