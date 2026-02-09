import { describe, expect, it } from 'vitest';

import { buildCatalogModelList, classifySessionModeKind, classifyRuntimeSwitchKind, describeResumeSupportKind } from './providerDetailsInfo';

describe('providerDetailsInfo', () => {
    it('builds a de-duplicated catalog model list with default first', () => {
        expect(buildCatalogModelList({ defaultMode: 'gemini-2.5-pro', allowedModes: ['gemini-2.5-pro', 'gemini-2.5-flash'] })).toEqual([
            'gemini-2.5-pro',
            'gemini-2.5-flash',
        ]);

        expect(buildCatalogModelList({ defaultMode: 'default', allowedModes: ['default'] })).toEqual(['default']);
    });

    it('classifies resume support kinds', () => {
        expect(describeResumeSupportKind({ supportsVendorResume: true, experimental: false, runtimeGate: null })).toBe('supported');
        expect(describeResumeSupportKind({ supportsVendorResume: true, experimental: true, runtimeGate: null })).toBe('supportedExperimental');
        expect(describeResumeSupportKind({ supportsVendorResume: false, experimental: false, runtimeGate: 'acpLoadSession' })).toBe('runtimeGatedAcpLoadSession');
        expect(describeResumeSupportKind({ supportsVendorResume: false, experimental: false, runtimeGate: null })).toBe('notSupported');
    });

    it('classifies session mode and runtime switching kinds', () => {
        expect(classifySessionModeKind('none')).toBe('none');
        expect(classifySessionModeKind('acpPolicyPresets')).toBe('acpPolicyPresets');
        expect(classifySessionModeKind('acpAgentModes')).toBe('acpAgentModes');

        expect(classifyRuntimeSwitchKind('none')).toBe('none');
        expect(classifyRuntimeSwitchKind('metadata-gating')).toBe('metadataGating');
        expect(classifyRuntimeSwitchKind('acp-setSessionMode')).toBe('acpSetSessionMode');
        expect(classifyRuntimeSwitchKind('provider-native')).toBe('providerNative');
    });
});
