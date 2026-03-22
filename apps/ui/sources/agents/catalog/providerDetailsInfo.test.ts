import { describe, expect, it } from 'vitest';

import {
    buildCatalogModelList,
    classifyRuntimeSwitchKind,
    classifySessionModeDescriptor,
    describeResumeSupportKind,
} from './providerDetailsInfo';

describe('providerDetailsInfo', () => {
    it('builds a de-duplicated catalog model list with default first', () => {
        expect(buildCatalogModelList({ defaultMode: 'gemini-2.5-pro', allowedModes: ['gemini-2.5-pro', 'gemini-2.5-flash'] })).toEqual([
            'gemini-2.5-pro',
            'gemini-2.5-flash',
        ]);

        expect(buildCatalogModelList({ defaultMode: 'default', allowedModes: ['default'] })).toEqual(['default']);
    });

    it('classifies resume support kinds', () => {
        expect(describeResumeSupportKind({ supportsVendorResume: true, experimental: false })).toBe('supported');
        expect(describeResumeSupportKind({ supportsVendorResume: true, experimental: true })).toBe('supportedExperimental');
        expect(describeResumeSupportKind({ supportsVendorResume: false, experimental: false })).toBe('notSupported');
    });

    it('classifies structured session mode descriptors and runtime switching kinds', () => {
        expect(classifySessionModeDescriptor({ source: 'none', semantics: 'none', runtimeSwitch: 'none' })).toEqual({
            sessionModeKind: 'none',
            runtimeSwitchKind: 'none',
        });
        expect(classifySessionModeDescriptor({ source: 'acp', semantics: 'policy-presets', runtimeSwitch: 'metadata-gating' })).toEqual({
            sessionModeKind: 'acpPolicyPresets',
            runtimeSwitchKind: 'metadataGating',
        });
        expect(classifySessionModeDescriptor({ source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' })).toEqual({
            sessionModeKind: 'acpAgentModes',
            runtimeSwitchKind: 'acpSetSessionMode',
        });
        expect(classifySessionModeDescriptor({ source: 'provider-native', semantics: 'agent-modes', runtimeSwitch: 'provider-native' })).toEqual({
            sessionModeKind: 'staticAgentModes',
            runtimeSwitchKind: 'providerNative',
        });

        expect(classifyRuntimeSwitchKind('none')).toBe('none');
        expect(classifyRuntimeSwitchKind('metadata-gating')).toBe('metadataGating');
        expect(classifyRuntimeSwitchKind('acp-setSessionMode')).toBe('acpSetSessionMode');
        expect(classifyRuntimeSwitchKind('provider-native')).toBe('providerNative');
    });
});
