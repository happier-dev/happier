import { describe, expect, it } from 'vitest';

import {
    classifyPluginDiagnosticUsability,
    hasUnusablePluginDeclarationDiagnostic,
} from './declarationUsability';

const TARGETED_CONTRIBUTION_DIAGNOSTIC_REPRESENTATIVES = [
    'target_absent',
    'descriptor_semantic_invalid',
] as const;

describe('plugin diagnostic declaration usability', () => {
    it('keeps unrelated host-rendered repair surfaces usable for targeted-contribution failures', () => {
        expect(TARGETED_CONTRIBUTION_DIAGNOSTIC_REPRESENTATIVES.map((code) => (
            classifyPluginDiagnosticUsability(code)
        ))).toEqual(TARGETED_CONTRIBUTION_DIAGNOSTIC_REPRESENTATIVES.map(() => 'runtime'));
        expect(hasUnusablePluginDeclarationDiagnostic(TARGETED_CONTRIBUTION_DIAGNOSTIC_REPRESENTATIVES))
            .toBe(false);
    });

    it('fails closed for malformed and declaration-owning diagnostics', () => {
        expect(classifyPluginDiagnosticUsability('plugin_manifest_invalid')).toBe('declaration');
        expect(classifyPluginDiagnosticUsability('future_unknown_diagnostic')).toBe('declaration');
    });
});
